/**
 * Pure prompt-assembly builders for a chat turn. Each is a plain
 * function - options in, string or VeniceMessage out - with no loop
 * state and no side effects, so they test in isolation and `runChatLoop`
 * (./loop.ts) reads as a conductor that calls them. The per-turn
 * metadata block, the wall-clock paragraph, the thread-attachments
 * inventory, the system-preamble split, and the stored-Message ->
 * wire-shape projection all live here.
 *
 * The injection-order + freshness contract these builders serve is
 * documented in docs/dev/prompt-augmentation.md.
 */
import type { Message, ThreadAttachmentSummary } from '../supabase';
import type { VeniceMessage } from '../venice';
import { buildUserVeniceContent } from '../attachments';
import { buildToolboxStateBlock } from './system-prompt';
import {
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
} from '../tools/wire';
import { detectTimezone } from '../timezone';
import {
  buildRefinementThink,
  coerceSecondThoughts,
} from '../ui/second-thoughts';

// --- appended verbatim from chat/loop.ts ---
/** Placeholder string threads ship with from schema.sql + draft creation. */
const DEFAULT_THREAD_TITLE = 'New conversation';

/**
 * Render the `<thread_attachments>` per-turn metadata block listing
 * every file attachment that has appeared in this conversation. Three
 * sections, each shown only when non-empty:
 *
 *   - Live images: filenames the model can pass to analyze_image().
 *   - Live documents: filenames whose extracted text is inlined in
 *     the user turn where they were attached. Listed for recall ("yes,
 *     I still have the contract.pdf you sent earlier") - no separate
 *     tool needed to read them.
 *   - Expired: filenames whose binary was reclaimed by the 30-day
 *     expiry sweep. The model knows it can't analyze them and can
 *     tell the user the data is gone if asked.
 *
 * Why this lives in the system prompt, not the user turn: the per-
 * message inline note added by buildUserVeniceContent only covers
 * "this turn brought these images." Cross-turn recall - "you sent
 * me a screenshot earlier, can you re-analyze it?" - requires a
 * thread-wide view, which the inline note can't provide because the
 * model would have to scan every prior user turn to find filenames.
 *
 * Returns null when the thread has no attachments at all so a clean
 * conversation pays zero token cost. Duplicates are de-duplicated per
 * section by filename (taking the most recent occurrence's category)
 * to keep the block readable when the user repeats a filename across
 * turns.
 */
export function buildThreadAttachmentsBlock(
  summaries: ThreadAttachmentSummary[]
): string | null {
  if (summaries.length === 0) return null;

  // De-duplicate by filename within each bucket so a re-attached file
  // appears once. Sorted by created_at ascending in the supabase query,
  // so the last write wins on category collisions (e.g. live then later
  // expired - we trust expired_at on the most recent row).
  const liveImages = new Map<string, true>();
  const liveDocs = new Map<string, true>();
  const expired = new Map<string, true>();
  for (const s of summaries) {
    if (s.expired) {
      // An expired filename trumps an earlier live entry of the same
      // name, since the binary really is gone now.
      liveImages.delete(s.filename);
      liveDocs.delete(s.filename);
      expired.set(s.filename, true);
    } else if (s.is_image) {
      expired.delete(s.filename);
      liveDocs.delete(s.filename);
      liveImages.set(s.filename, true);
    } else {
      expired.delete(s.filename);
      liveImages.delete(s.filename);
      liveDocs.set(s.filename, true);
    }
  }

  const lines: string[] = ['<thread_attachments>'];
  if (liveImages.size > 0) {
    lines.push(
      `Live images: ${[...liveImages.keys()].join(', ')}. Call analyze_image(filename, query) to inspect any of them.`
    );
  }
  if (liveDocs.size > 0) {
    lines.push(
      `Live documents: ${[...liveDocs.keys()].join(', ')}. Their extracted text is inlined in the user turns where they were attached.`
    );
  }
  if (expired.size > 0) {
    lines.push(
      `Expired (binary reclaimed after 30d, no longer inspectable): ${[...expired.keys()].join(', ')}.`
    );
  }
  lines.push('</thread_attachments>');

  // If every category was empty after de-dup (shouldn't happen given
  // the early-return above, but defensive in case a future schema
  // change adds a fourth category and de-dup empties everything),
  // skip the block entirely so we don't ship just the wrapper tags.
  if (lines.length === 2) return null;
  return lines.join('\n');
}

/**
 * Format a millisecond duration as a coarse, conversational
 * description of elapsed time. The output is intentionally fuzzy -
 * the model uses this to calibrate its register ("you just asked"
 * vs "it's been a while") rather than to do arithmetic, so a stepped
 * bucket matches the LLM's actual decision boundary better than a
 * precise "22 hours 14 minutes" string.
 *
 * Negative or non-finite input returns "just now" - clock skew (a
 * persisted assistant row whose created_at is slightly in the
 * future relative to the browser's `Date.now()` because the DB
 * stamped it on the server side) shouldn't surface as a baffling
 * "in the future" string in the prompt.
 */
function formatRelativeDuration(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'just now';
  const sec = Math.floor(elapsedMs / 1000);
  if (sec < 120) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 10) return 'a few minutes';
  if (min < 60) return `about ${min} minutes`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? 'about an hour' : `about ${hr} hours`;
  const day = Math.floor(hr / 24);
  if (day < 2) return 'yesterday';
  if (day < 14) return `about ${day} days`;
  const week = Math.floor(day / 7);
  if (day < 60) return `about ${week} weeks`;
  const month = Math.floor(day / 30);
  if (month < 12) return `about ${month} months`;
  return 'over a year';
}

/**
 * Render the wall-clock paragraph that opens the per-turn metadata
 * system message. Inlines local + UTC + IANA-zone in one prose
 * sentence rather than the prior `<datetime>` tag, and tacks on a
 * "since your last reply" sentence when the chat-loop's caller
 * supplied a `lastAssistantTimestamp` for the elapsed-bucket helper.
 *
 * The opening turn of a thread has no prior assistant message to
 * anchor against, so callers pass null/undefined and the second
 * sentence is dropped - the model gets the absolute clock but no
 * "just now" noise. Computed fresh per round so multi-tool turns
 * stretching past a minute don't carry a stale wall-clock value.
 *
 * Why a prose paragraph rather than the prior `<datetime>` XML tag:
 * the tag form was a workaround for needing a structural boundary
 * inside the user role (so platform-injected reference material
 * could ride alongside the user's words). Putting the datetime in a
 * dedicated system message removes that requirement; prose reads
 * more naturally and the model still answers "what time is it?"
 * correctly because the value is right there.
 */
function buildDatetimeParagraph(
  tz: string | null | undefined,
  lastAssistantTimestamp: string | null | undefined,
): string {
  const now = new Date();
  // Minute granularity, deliberately. This paragraph leads the per-turn
  // metadata system message, which rides at the tail of every request
  // and is rebuilt each round (see the assembly in runChatLoop). A
  // seconds-precision clock would change the block's bytes between tool
  // rounds seconds apart and defeat Venice's prompt-prefix cache on the
  // trailing block; truncating to the minute keeps it byte-stable for
  // every round inside the same minute. ISO 8601 minute form
  // ('YYYY-MM-DDTHH:MMZ') is valid and unambiguous.
  const utc = now.toISOString().slice(0, 16) + 'Z';
  const zone = typeof tz === 'string' && tz.length > 0 ? tz : detectTimezone();
  let local = utc;
  let zoneLabel = zone;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      // 'longOffset' returns 'GMT-07:00' / 'GMT+00:00' across modern
      // engines; older Safari has used 'GMT' alone for UTC, which the
      // regex below tolerates by falling back to 'Z'.
      timeZoneName: 'longOffset',
    }).formatToParts(now);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    let h = get('hour');
    // Some Intl runtimes emit '24' for midnight under hour12=false;
    // ISO 8601 wants '00' for the same instant.
    if (h === '24') h = '00';
    const tzn = get('timeZoneName');
    const m = /GMT([+-]\d{2}:\d{2})$/.exec(tzn);
    const offset = m ? m[1] : 'Z';
    local = `${get('year')}-${get('month')}-${get('day')}T${h}:${get('minute')}${offset}`;
  } catch {
    // Unknown / rejected zone (older Safari has been stricter about
    // unfamiliar IANA names). Fall back to UTC for both forms - the
    // model still gets a usable timestamp, it just loses the local
    // calibration.
    zoneLabel = 'UTC';
  }
  const lines: string[] = [
    `Current local time: ${local} (zone ${zoneLabel}; UTC ${utc}).`,
  ];
  if (typeof lastAssistantTimestamp === 'string' && lastAssistantTimestamp.length > 0) {
    const anchor = Date.parse(lastAssistantTimestamp);
    // Date.parse returns NaN for an unparseable input (corrupt row,
    // legacy timestamp shape). Skip the sentence rather than ship a
    // garbage value.
    if (Number.isFinite(anchor)) {
      const bucket = formatRelativeDuration(now.getTime() - anchor);
      // The formatter returns either an absolute reference
      // ('yesterday', 'just now') or a duration ('a few minutes',
      // 'about 22 hours', 'over a year'). Durations want a trailing
      // 'ago' to read naturally; absolute references don't.
      const ago = bucket === 'just now' || bucket === 'yesterday' ? '' : ' ago';
      lines.push(`Your last reply on this thread was ${bucket}${ago}.`);
    }
  }
  return lines.join('\n');
}

/**
 * Options bag for {@link buildMetadataSystemMessage}. The chat-loop
 * fills this fresh per round so the resulting message reflects the
 * latest wall-clock, the live thread title, and the current
 * attachments inventory. Every field is optional - a fresh account
 * with no profile, no attachments, no emphasis toggle, and a
 * non-placeholder title produces a metadata message carrying nothing
 * but the datetime paragraph.
 */
interface MetadataSystemMessageOptions {
  userName?: string | null;
  userLocation?: string | null;
  displayTimezone?: string | null;
  lastAssistantTimestamp?: string | null;
  /**
   * The thread's enabled gated-toolbox set for this turn. Rendered as
   * the (on)/(off) state block right after the datetime paragraph. Lives
   * here rather than in the baseline catalog so a mid-conversation
   * toggle only re-encodes this trailing block instead of busting the
   * prompt-prefix cache for the whole conversation.
   */
  enabledToolboxes: readonly string[];
  attachmentSummaries: ThreadAttachmentSummary[];
  /**
   * True when the user message that opened this turn carries one or
   * more attachments. Drives the anti-fabrication reinforcement
   * section - distinct from `attachmentSummaries`, which is the
   * thread-wide inventory and stays populated for the rest of the
   * conversation even on turns that bring no new file.
   */
  currentTurnHasAttachments: boolean;
  emphasisMarkdown?: boolean;
  threadTitle: string;
  titleManuallySet: boolean;
  /**
   * 1-based count of user messages in this thread including the
   * current one. Title nudges are skipped on round 1 - the server-side
   * auto-title agent (supabase/functions/venice/agents/auto_title.ts)
   * handles naming there; the metadata-message nudges only fire from
   * round 2 onward as a safety net for the case where the agent
   * hasn't polled yet.
   */
  currentUserRound: number;
}

/**
 * Compose the per-turn metadata system message. Returns one
 * VeniceMessage with `role: 'system'` whose body stitches the
 * applicable sections together with blank lines:
 *
 *   1. User profile (name / location), when either is set.
 *   2. Datetime paragraph (always present).
 *   3. Gated-toolbox on/off state (always present). Sits right after
 *      the datetime so the volatile state that a toggle_toolbox call
 *      flips rides in this trailing block - the baseline catalog is
 *      state-free, so a toggle re-encodes only this block instead of
 *      busting the prompt-prefix cache for the whole conversation.
 *   4. Thread attachments inventory, when there are any.
 *   5. Attachment-inspection reinforcement, when the current turn
 *      brought a file. Anti-fabrication: pins any claim about a
 *      file's contents to material actually read this turn.
 *   6. Emphasis-markdown formatting nudge, when the toggle is on.
 *   7. Title nudge, from round 2 onward: the loud placeholder nag
 *      when the title is still the schema default, the soft
 *      topic-drift hint when the title is model-set and not pinned
 *      by the user. Round 1 is silent here - the auto-title worker
 *      owns naming on the opening turn.
 *
 * The chat-loop inserts this message AFTER the user-configured
 * system prompts and BEFORE the user turn, so the model reads it
 * just before reading the user's words. Each round rebuilds the
 * message so wall-clock + attachments + title state stay live across
 * multi-tool rounds.
 */
export function buildMetadataSystemMessage(
  opts: MetadataSystemMessageOptions
): VeniceMessage {
  const sections: string[] = [];

  const profile = (() => {
    const name = (opts.userName ?? '').trim();
    const location = (opts.userLocation ?? '').trim();
    if (name.length === 0 && location.length === 0) return null;
    const lines: string[] = [];
    if (name.length > 0) lines.push(`User's name: ${name}`);
    if (location.length > 0) lines.push(`User's location: ${location}`);
    return lines.join('\n');
  })();
  if (profile !== null) sections.push(profile);

  sections.push(
    buildDatetimeParagraph(opts.displayTimezone, opts.lastAssistantTimestamp),
  );

  // Gated-toolbox on/off state, pinned right after the datetime. The
  // baseline system prompt's catalog lists what exists; this carries
  // the current enabled set. Kept out of the baseline so a
  // toggle_toolbox flip mid-conversation only re-encodes this trailing
  // block, not the whole cached prefix.
  sections.push(buildToolboxStateBlock(opts.enabledToolboxes));

  const attachments = buildThreadAttachmentsBlock(opts.attachmentSummaries);
  if (attachments !== null) sections.push(attachments);

  // Anti-fabrication reinforcement, fired only on turns where the user
  // actually attached a file. Without it the model tends to answer "as
  // if" it inspected the upload - describing an image from its filename,
  // summarising a document it never read - because the inlined content
  // and the analyze_image tool are both easy to skip past. The block
  // pins every claim about a file to material the model demonstrably
  // has this turn (inlined text, inlined image, or an analyze_image
  // result) and tells it to call the tool or admit it can't see the
  // file rather than invent an analysis. Gated on the current turn (not
  // the thread-wide inventory) so a conversation with one old upload
  // doesn't pay this on every later text-only turn.
  if (opts.currentTurnHasAttachments) {
    sections.push(
      [
        'The current message includes one or more file attachments. Any',
        'statement you make about their contents must come from material',
        'you have actually inspected this turn: the extracted text inlined',
        'above, the image inlined above, or the result of an analyze_image',
        'call. Do not describe, summarise, or quote a file based on its',
        'filename, its type, or what such a file usually contains. If you',
        'cannot actually see a file - for example an image on a model',
        'without vision that you have not yet passed to analyze_image -',
        'call the tool or tell the user you cannot see it. Never present an',
        'analysis you did not perform.',
      ].join('\n'),
    );
  }

  if (opts.emphasisMarkdown) {
    sections.push(
      [
        'Formatting: when the reply runs more than a sentence or two,',
        'use light Markdown emphasis as scan-points so the reader can',
        'skim. Bold (`**term**`) meaningful single words, proper nouns,',
        'and identifiers - things the reader should fix on. Italicise',
        '(`*phrase*`) short phrases, transitional clauses, or compound',
        'noun phrases that orient the reader. Either style works for a',
        'single or compound word; pick bold for terms worth fixing on,',
        'italics for phrases that set up what comes next. Aim for',
        'roughly one emphasised span per sentence in prose; less in',
        'code-heavy, list-heavy, or tabular passages. Do not emphasise',
        'whole sentences, filler adjectives, or boilerplate - the',
        'emphasis should reward skimming, not compete with it. Skip',
        "emphasis on short replies where skimming wouldn't help.",
      ].join('\n'),
    );
  }

  // Title nudges are silent on round 1 - the server-side auto-title
  // agent (supabase/functions/venice/agents/auto_title.ts) polls the
  // threads table for rows still on the placeholder and titles them
  // in the background, so the model never has to. From round 2 on,
  // if the agent hasn't landed yet (it may not have polled the row)
  // the loud nag below
  // fires to recover; if a model-set title is already in place but
  // the topic may have drifted, the soft drift hint fires instead.
  // Manually-named threads suppress both nudges - the user
  // committed and we don't clobber that.
  if (opts.currentUserRound >= 2 && !opts.titleManuallySet) {
    if (opts.threadTitle === DEFAULT_THREAD_TITLE) {
      sections.push(
        [
          'This thread is still labelled with the default placeholder',
          `("${DEFAULT_THREAD_TITLE}") in the conversation drawer. Before`,
          'replying, call `update_title` with a concise 3-6 word title',
          'describing what the user is actually asking about. Plain',
          'text, no quotes, no trailing punctuation, no Markdown',
          'formatting (the title is a plain label, not prose).',
        ].join('\n'),
      );
    } else {
      sections.push(
        [
          `Current conversation title: "${opts.threadTitle}". If the topic`,
          'has meaningfully shifted, call `update_title` with a better',
          '3-6 word title. Cosmetic drift is not a reason to rename.',
        ].join('\n'),
      );
    }
  }

  return { role: 'system', content: sections.join('\n\n') };
}

/**
 * Split a history array into the leading user-configured system
 * messages and the conversation that follows. The chat-loop emits the
 * baseline system prompt first, then this `userSystem` run (voice /
 * persona tuning), then `conversation`, then the per-turn metadata
 * block as the final row. Metadata is pinned at the tail rather than
 * mixed into the preamble so the stable baseline + user-system +
 * history form a cacheable request prefix (see the assembly in
 * runChatLoop for the prompt-cache rationale).
 *
 * Stops collecting system messages at the first non-system row. A
 * legitimate `role: 'system'` row that arrives after the first
 * user/assistant pair would land in the conversation half, but no
 * current caller produces that shape - system rows ride at the head.
 */
export function splitSystemPreamble(
  messages: VeniceMessage[],
): { userSystem: VeniceMessage[]; conversation: VeniceMessage[] } {
  const userSystem: VeniceMessage[] = [];
  const conversation: VeniceMessage[] = [];
  let inPreamble = true;
  for (const m of messages) {
    if (inPreamble && m.role === 'system') {
      userSystem.push(m);
    } else {
      inPreamble = false;
      conversation.push(m);
    }
  }
  return { userSystem, conversation };
}

/**
 * Project a stored Message row onto the OpenAI wire format. Handles the
 * three shapes we emit: plain text (system/user/assistant-text), an
 * assistant row that invoked tools (`tool_calls` attached, content may
 * be empty), and a tool-result row (`role='tool'` with tool_call_id and
 * name).
 */
export function toVeniceMessage(
  m: Message,
  opts?: {
    visionSpec?: { supportsVision: boolean };
    /**
     * Attachment id -> signed URL for the live image attachments, pre-
     * resolved by the caller (see SupabaseService.createAttachmentSignedUrls).
     * Venice's vision input fetches these URLs server-side. Empty/omitted
     * means no images inline (older callers, non-vision sends, history
     * replay where a URL couldn't be minted).
     */
    imageUrls?: ReadonlyMap<string, string>;
  }
): VeniceMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id:
        m.tool_call_id != null
          ? sanitizeToolCallIdForWire(m.tool_call_id)
          : undefined,
      name: m.name ?? undefined,
    };
  }
  // User messages may carry attachments; build the multimodal content
  // through the attachments helper so extracted text lands as fenced
  // prelude blocks and images inline as `image_url` parts on vision
  // tiers. Passing a default (non-vision) spec when the caller doesn't
  // provide one keeps older callers working — they just never inline
  // images. See buildUserVeniceContent for the rules.
  if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
    const content = buildUserVeniceContent(
      m.content,
      m.attachments,
      opts?.visionSpec ?? { supportsVision: false },
      opts?.imageUrls ?? new Map()
    );
    return { role: 'user', content };
  }
  const out: VeniceMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant') {
    if (m.tool_calls && m.tool_calls.length > 0) {
      out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
    }
    // Second-thoughts connective. A doubt the user ACTED on (clicked
    // the refinement button) becomes model-visible: append it as a
    // `<think>` so replay carries the logical link between this answer
    // and the refinement that follows - otherwise the model sees two
    // consecutive answers with no "why" and can waffle over which is
    // authoritative on a dependent turn. Un-acted doubts stay a
    // display-only column, never projected. The same projection seeds
    // the refinement turn itself (its history includes this now-acted
    // row). See src/lib/ui/second-thoughts.ts.
    const verdict = coerceSecondThoughts(m.second_thoughts);
    if (verdict?.acted && typeof out.content === 'string') {
      out.content = `${out.content}\n\n${buildRefinementThink(verdict.note)}`;
    }
  }
  return out;
}

/**
 * Pull the plain-text portion of a user message off the wire shape.
 * `VeniceMessage.content` is `string | ContentPart[]`; multimodal
 * user messages with attachments arrive as the array form, in which
 * case we concatenate the `'text'` parts. Empty string when the
 * message has no text component (e.g. an image-only user message).
 */
