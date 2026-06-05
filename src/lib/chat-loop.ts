/**
 * Chat-loop orchestrator - runs one user turn from submission through
 * to a final assistant answer. After the streaming-root migration the
 * round chain, tool dispatch, rate-limit retry, output-guard re-rolls,
 * and assistant-row persistence all live server-side inside the venice
 * edge function. This module's job shrinks to:
 *
 *   - Build the per-turn priming layers (samskara fire + compound,
 *     intuition, context recall) and stitch their synthetic `<think>`
 *     blocks into the history baton.
 *   - Assemble the three-layer system-prompt preamble (baseline +
 *     user-configured + per-turn metadata).
 *   - Issue a single `venice.streamChat` call with `streamCtx` pointed
 *     at this thread + anchor user message. The venice client routes
 *     through the /stream endpoint and yields the server-published
 *     event union.
 *   - Map each event onto the UI handler surface so the streaming
 *     bubble, reasoning panel, tool timings, rate-limit indicator,
 *     and slop-notice cards stay live during the turn.
 *   - At END, capture the persisted assistant row id + terminal kind,
 *     fire onAssistantPersisted with the canonical Message, and write
 *     the samskara substrate stub anchoring the (user message, last
 *     assistant) pair.
 *
 * Browser vs function ownership during a turn. The browser writes the
 * `role='user'` message row from the composer-send click before
 * `runChatLoop` runs - that row is browser-owned because its production
 * path is a single user click and "tab crash means user retypes." Once
 * `runChatLoop` calls `venice.streamChat`, the function takes over as
 * writer-of-record for everything that follows: assistant rows
 * (`commit_assistant_message`), `role='tool'` rows, `tool_calls`,
 * `threads.status` transitions, per-round generated-image attachments,
 * and `threads.last_error` on the terminal-error path. This module
 * persists nothing during the turn - it consumes events and updates the
 * UI. The full ownership frame (production-path-per-row, not
 * per-table) is in docs/dev/architecture.md under "Production-path
 * ownership"; the function-side perspective is in
 * supabase/functions/README.md.
 *
 * Cancellation: the caller's AbortSignal aborts the local stream
 * consumer (so the UI stops collecting events). The function-side
 * round chain is cancelled separately via a control-channel publish
 * (see `cancelStream` in venice.ts). Both fire from the stop button
 * so the in-flight Venice fetch and the local UI tear down in lock
 * step.
 */

import type { ReasoningEffort, Verbosity } from './models';
import { MODELS } from './models';
import type {
  SupabaseService,
  Message,
  Thread,
  ThreadAttachmentSummary,
  Attachment,
} from './supabase';
import type {
  VeniceClient,
  VeniceMessage,
  TokenUsage,
  Citation,
  StreamEvent,
} from './venice';
import { VeniceError, streamReconnect } from './venice';
import { buildUserVeniceContent } from './attachments';
import {
  buildToolList,
  type OpenAIToolCall,
} from './tools';
import { buildSystemPrompt } from './chat-prompt';
import { askUser, type AskUserOption } from './tools/ask_user';
import {
  parseToolArguments,
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
} from './tools/wire';
import {
  fireSamskaras,
  formatPrimingThinks,
  getCompoundSummary,
  recordSubstrateStub,
  type FireResult,
} from './samskara';
import {
  getBiasProfileBlock,
  notifyBiasNewUserMessage,
  snapshotBiasActiveBiases,
} from './bias';
import { detectTimezone } from './timezone';
import { createLogger } from './logger.svelte';
import {
  buildIntuitionThinkMessage,
  countUserRounds,
  evaluatePreRoundTrigger,
  readIntuitionCache,
  runIntuitionPipeline,
  withIntuitionInflight,
  writeIntuitionCache,
  type IntuitionPayload,
} from './intuition';
import {
  buildContextRecallThinkMessage,
  readContextRecallCache,
  runContextRecallPipeline,
  withContextRecallInflight,
  writeContextRecallCache,
  type ContextRecallPayload,
} from './context-recall';

const log = createLogger('chat-loop');

/**
 * Hard cap on the wait for samskara priming before the first
 * assistant round starts. Common case lands well under this; the
 * cap exists so a slow Venice or a hiccup in the cosine RPC can't
 * add visible latency to the user's first token. Picked at 1500ms
 * because async chat tolerates a half-second send delay but not
 * more - anything beyond that and the user starts noticing.
 */
const SAMSKARA_PRIMING_TIMEOUT_MS = 1500;

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
   * current one. Title nudges are skipped on round 1 - the auto-title
   * worker (see `src/lib/agents/auto_title/`) handles naming there;
   * the metadata-message nudges only fire from round 2 onward as a
   * safety net for the case where the worker hasn't polled yet.
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
 *   3. Thread attachments inventory, when there are any.
 *   4. Attachment-inspection reinforcement, when the current turn
 *      brought a file. Anti-fabrication: pins any claim about a
 *      file's contents to material actually read this turn.
 *   5. Emphasis-markdown formatting nudge, when the toggle is on.
 *   6. Title nudge, from round 2 onward: the loud placeholder nag
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
function buildMetadataSystemMessage(
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

  // Title nudges are silent on round 1 - the auto-title worker
  // (src/lib/agents/auto_title/*) polls the threads table for rows
  // still on the placeholder and titles them in the background, so
  // the model never has to. From round 2 on, if the worker hasn't
  // landed yet (it may not have polled, or the user is on a brand-
  // new device that hasn't taken the lease) the loud nag below
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
          'text, no quotes, no trailing punctuation.',
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
function splitSystemPreamble(
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
 * Which subconscious-priming pipeline a status signal refers to. These
 * are the three pre-response background jobs the chat-loop runs before
 * (and, for the title trigger, during) a turn:
 *
 *   'samskara'  - situational fire (top-k predictions for this turn).
 *   'intuition' - perception + drives + synthesis.
 *   'recall'    - memory + conversation + wiki pull, stitched into one
 *                 first-person recollection note.
 *
 * Used as the key for the onSubconsciousStart/End handler pair so the
 * UI can show a per-pipeline throbber while each runs.
 */
export type SubconsciousOp = 'samskara' | 'intuition' | 'recall';

/** Event surface consumed by the UI. Each callback is best-effort. */
export interface ChatLoopHandlers {
  /** Cumulative text for the current round; fires on every text delta. */
  onTextUpdate?(text: string): void;
  /**
   * Cumulative reasoning / chain-of-thought text for the current round.
   * Fires on every reasoning delta, which on reasoning-capable models
   * arrives before the visible `onTextUpdate` stream. The UI uses the
   * transition from "reasoning arriving" to "text arriving" to animate
   * the reasoning panel closed.
   */
  onReasoningUpdate?(text: string): void;
  /** A tool call has been received from the model and is about to execute. */
  onToolStart?(call: OpenAIToolCall): void;
  /** A tool call resolved successfully. `result` is the parsed JS value. */
  onToolDone?(call: OpenAIToolCall, result: unknown): void;
  /** A tool call threw or was aborted. */
  onToolError?(call: OpenAIToolCall, error: Error): void;
  /** The assistant row for the current round has been written to Supabase. */
  onAssistantPersisted?(message: Message): void;
  /** A tool-result row has been written (fires once per tool). */
  onToolResultPersisted?(message: Message): void;
  /**
   * Generated-image attachments were written to the terminal assistant
   * row at end of turn (from one or more generate_image calls). Fires
   * once, with the message id they were attached to and the hydrated
   * rows, so the UI can patch the in-memory assistant message without a
   * refetch - the same way the user-upload path patches attachments
   * onto the just-sent user message. Skipped when no image was
   * generated this turn.
   */
  onAssistantAttachments?(messageId: string, attachments: Attachment[]): void;
  /**
   * The thread's gated-toolbox set changed during the round (triggered
   * by a `toggle_toolbox` call from the model). UI surfaces this as
   * a flash on the composer toolbox button. The handler receives the
   * new enabled array verbatim; callers wanting a delta should diff
   * against what they stored.
   */
  onToolboxesEnabledChange?(enabled: readonly string[]): void;
  /**
   * The thread title changed mid-turn (triggered by an `update_title`
   * call from the model). Fires with the sanitised title the handler
   * actually wrote. The UI uses this to patch the thread row and
   * re-bucket the drawer immediately, instead of waiting for the
   * end-of-turn `refreshThreads()` to pick the new title up.
   */
  onTitleChange?(title: string): void;
  /**
   * A fresh intuition payload was computed for this thread (pre-round
   * trigger, title trigger, or stale-fuse). Fires with the new payload
   * so the UI can update the modal / inline indicator without waiting
   * for the next thread re-fetch. Skipped on rounds where the cache is
   * reused as-is - we only signal *changes*.
   */
  onIntuitionUpdate?(payload: IntuitionPayload): void;
  /**
   * A fresh context-recall payload was computed for this thread (the
   * pre-round trigger, title trigger, or stale fuse fired and the
   * pipeline produced a payload). Sibling of onIntuitionUpdate -
   * fires once per refresh, with the freshly-computed payload, so the
   * UI can patch the in-memory thread row without waiting for the
   * next thread re-fetch. Skipped on rounds where the cache is reused
   * as-is.
   */
  onContextRecallUpdate?(payload: ContextRecallPayload): void;
  /**
   * A subconscious-priming pipeline started (`...Start`) or settled
   * (`...End`) for this turn. A liveness pair, like
   * onRateLimitWait/onRateLimitResolved: every Start is followed by
   * exactly one End regardless of outcome (fresh payload, empty result,
   * or error - the throbber signals "this is running", not "this
   * succeeded"). `op` keys which pipeline fired. Intuition and recall
   * run in parallel and the samskara fire overlaps both, so more than
   * one op can be active at once; the UI tracks a set, not a single
   * flag. The samskara End can land after the priming race timeout has
   * already let the turn proceed (the fire keeps running in the
   * background), so a UI consuming these must tolerate an End that
   * arrives once streaming is well underway.
   */
  onSubconsciousStart?(op: SubconsciousOp): void;
  onSubconsciousEnd?(op: SubconsciousOp): void;
  /**
   * The current round hit a Venice 429 and the loop is going to wait
   * before re-issuing the request. Fires once per wait, before the
   * sleep starts; `onRateLimitResolved` fires when the next attempt
   * begins (whether or not it succeeds). The UI uses this pair to
   * swap the streaming-bubble spinner for a "waiting on Venice"
   * indicator with a cancel button. The cancel path is the same
   * abort signal the stop button uses - aborting during the wait
   * lands in the existing AbortError branch and writes an
   * INTERRUPTED_MARKER row, identical to a mid-stream cancel.
   *
   * `attempt` is 1-indexed - the first wait after the initial 429
   * is attempt 1. `until` is a wall-clock epoch ms target, suitable
   * for rendering a live countdown. `retryAfterMs` is the parsed
   * hint from the Venice headers (Retry-After or
   * x-ratelimit-reset-{requests,tokens}); null when Venice didn't
   * supply one and the loop fell back to its own backoff.
   */
  onRateLimitWait?(info: {
    retryAfterMs: number | null;
    attempt: number;
    until: number;
  }): void;
  /**
   * A rate-limit wait period has ended - either the sleep elapsed
   * and the next attempt is starting, or the request that followed
   * a wait succeeded. Always fires after a matching
   * `onRateLimitWait`. The UI uses this to swap the waiting
   * indicator back to the normal streaming spinner.
   */
  onRateLimitResolved?(): void;
  /**
   * An output guard rejected the current streaming attempt as junk
   * (e.g. a leaked special token) and the loop is re-rolling. Fires
   * once per re-roll, before the next attempt's stream opens, with the
   * tripping guard's name and the 1-based retry number. None of the
   * discarded attempt's text reached the consumer, so the UI's job is
   * cosmetic: drop a stylized "discarded a glitch, regenerating" notice
   * (the "oops, all slop!" card) and reset the streaming buffers so the
   * replacement renders cleanly. The notice is animated away once the
   * replacement persists.
   */
  onGuardRetry?(info: { guard: string; attempt: number }): void;
}

export interface ChatLoopOptions {
  venice: VeniceClient;
  supabase: SupabaseService;
  /** Thread we're replying on; used for the tool context and persistence. */
  thread: Thread;
  /** Signed-in user id (used to scope the tool context). */
  userId: string;
  /** Concrete Venice model id to send as `model` in every round. */
  modelId: string;
  /**
   * Prior message history in OpenAI shape — starts with any system
   * messages, ends with the user message that triggered this call. The
   * chat-loop prepends its own catalog system message on top; it
   * doesn't persist that prepended message.
   */
  history: VeniceMessage[];
  signal: AbortSignal;
  handlers?: ChatLoopHandlers;
  /**
   * Optional reasoning-effort knob forwarded to every streamChat call.
   * Caller (Chat.svelte) is expected to only set this on models whose
   * ModelSpec marks `supportsReasoning: true` — we don't re-check here
   * because the chat-loop only sees the concrete model id, not the spec.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Tier-level kill switch for reasoning. When true, every streamChat
   * call this turn ships `venice_parameters.disable_thinking: true`.
   * Caller (Chat.svelte) is expected to also omit `reasoningEffort`
   * when this is true - the two knobs are mutually exclusive on the
   * wire (reasoning_effort: 'low' shrinks the CoT but doesn't disable
   * it; disable_thinking is the full off switch). Used by the Fast
   * tier so it stays fast even though it fronts a reasoning-capable
   * model.
   */
  disableThinking?: boolean;
  /**
   * Optional text.verbosity knob forwarded to every streamChat call.
   * Unlike reasoningEffort there's no model-capability gate — providers
   * that don't recognize the field silently ignore it.
   */
  verbosity?: Verbosity;
  /**
   * When true, the per-turn metadata system message carries a short
   * formatting nudge asking the model to sprinkle light Markdown
   * emphasis (bold terms, italic phrases) through its reply as
   * scan-points. Opt-in; the block is skipped when false/absent so
   * users who didn't ask for it never see formatting hints. See
   * `buildMetadataSystemMessage` for the exact wording - modifying
   * it changes model behaviour on every turn of every user who has
   * the toggle on.
   */
  emphasisMarkdown?: boolean;
  /**
   * Optional free-form display name + location the user entered in
   * Settings -> AI -> About you. When either is non-empty, the
   * per-turn metadata system message opens with a short identity
   * paragraph so the model can address the user naturally and
   * ground location-specific answers (weather, local time, regional
   * context). Both empty / absent skips the block entirely so a
   * fresh account pays zero tokens. See `buildMetadataSystemMessage`
   * for the exact rendered shape - editing that wording changes
   * model behaviour on every turn of every user who has filled the
   * form.
   */
  userName?: string | null;
  userLocation?: string | null;
  /**
   * IANA timezone used to format the wall-clock paragraph the
   * per-turn metadata system message opens with (see
   * `buildDatetimeParagraph`). When null / undefined the helper falls
   * back to the runtime's reported zone (typically the browser's
   * own). A wrong value here surfaces as the model giving the user
   * the wrong wall-clock time.
   */
  displayTimezone?: string | null;
  /**
   * ISO 8601 `created_at` of the most recent persisted assistant
   * message on the thread, used to compute the "about X since your
   * last reply" sentence in the per-turn metadata system message.
   * Null / undefined on the opening turn of a thread (no prior
   * assistant message); the metadata message then omits the elapsed
   * sentence rather than shipping a meaningless "just now". Caller
   * (Chat.svelte) walks its `messages` array for the latest
   * role==='assistant' row - synthetic ephemeral injections
   * (intuition / context-recall / samskara `<think>` blocks) are
   * not persisted and therefore not eligible anchors, which is the
   * correct semantic: "how long since your last actual reply to the
   * user?".
   */
  lastAssistantTimestamp?: string | null;
  /**
   * Id of the user message that opened this turn. Anchors the
   * streaming-root request: the function uses it to pair the streamed
   * assistant row to its parent user message via the
   * commit_assistant_message RPC's conflict check, and the browser
   * passes it to /stream so a concurrent foreign send is detected
   * server-side. Required since the streaming-root collapse - the
   * direct-Venice path that previously coped with its absence no
   * longer runs from here.
   */
  userMessageId: string;
  /**
   * Concrete Venice model id used by the intuition pipeline (perception
   * + 5 drives + synthesis). Caller resolves the fast tier. Omitted /
   * undefined disables the intuition feature entirely on this turn -
   * older callers (older test fixtures) keep working without knowing
   * the field exists. The cache is left untouched when this is absent,
   * so a turn without an intuition model doesn't invalidate prior
   * payloads.
   */
  intuitionModelId?: string;
  /**
   * Mood snapshot at turn-entry. The chat-loop compares it against the
   * cached payload's mood snapshot to decide whether the band /
   * confidence column has shifted enough to warrant a refresh. Null /
   * undefined disables the mood-shift trigger - the title trigger and
   * stale fuse still operate. Both bands and column come from the same
   * MOOD_TABLE the samskara mood pill renders against (see
   * src/lib/samskara/events.ts).
   */
  intuitionMood?: { band: number; column: 'confident' | 'tentative' } | null;
  /**
   * Whether to run the context-recall pipeline alongside intuition.
   * When true, the same trigger evaluator that schedules an intuition
   * refresh ALSO schedules a context-recall refresh (cold-start, mid-
   * turn title shift, mood-band shift, stale fuse) - the two pipelines
   * run in parallel, both write their own cache columns, and both
   * inject their own synthetic <think> block into the priming chain.
   *
   * Independent of `intuitionModelId`: a caller can run only intuition,
   * only context-recall, both, or neither. The trigger evaluator is
   * shared; the cache + pipeline machinery is sibling-but-separate.
   *
   * Omitted / false: the context-recall pipeline does not fire, the
   * cache is left untouched, and `onContextRecallUpdate` never invokes -
   * identical pre-feature behaviour, so older tests / callers stay
   * green without knowing the field exists.
   */
  contextRecallEnabled?: boolean;
  /**
   * True when the user message that opened this turn carries one or
   * more attachments. Drives the metadata message's anti-fabrication
   * reinforcement (see `buildMetadataSystemMessage`), which pins the
   * model's claims about a file to content it actually inspected this
   * turn. Omitted / false on turns with no upload (and for older
   * callers / tests) so a text-only turn pays zero tokens for it.
   */
  currentTurnHasAttachments?: boolean;
}

/** Non-error completion shape returned to the caller. */
export interface ChatLoopResult {
  /** Final assistant text the user sees. Empty if the loop hit MAX_ROUNDS. */
  finalText: string;
  /** Number of streaming rounds that ran (>=1). */
  roundsRun: number;
  /** True if we stopped because of MAX_ROUNDS rather than a clean finish. */
  stoppedByLimit: boolean;
  /**
   * True if the loop exited because the caller's AbortSignal fired mid-
   * stream (user clicked the stop button). The UI uses this to skip
   * the "something went wrong" banner a generic catch would produce -
   * the user asked for the abort, it's not a failure to report.
   */
  interrupted: boolean;
  /**
   * True when the terminal assistant row could not be committed because
   * another device inserted a new user message after the user message
   * this loop was responding to. The generated content is discarded
   * server-side; the caller should surface a "conversation changed on
   * another device" prompt rather than treating this as an error.
   * Only set when userMessageId was provided; always false otherwise.
   */
  conflictDetected: boolean;
  /**
   * The thread's enabled gated-toolbox set at the end of the loop.
   * Callers persist this back to local state so subsequent user sends
   * see the same surface the model last saw.
   */
  toolboxesEnabled: readonly string[];
  /**
   * Non-null when the loop exited because the model called the
   * `ask_user` tool and is now waiting on a human answer. The tool-
   * result row is already written (carrying the pending sentinel as
   * its content) so the wire shape stays valid; conversation-recovery
   * sees every tool_call_id matched and stays a no-op. The caller
   * (Chat.svelte) is expected to surface the question via the
   * AskUserCard UI, fire a notification, and on submit:
   *   1. UPDATE the tool row's content to the answer payload via
   *      `supabase.updateToolMessageContent(threadId, toolCallId, ...)`,
   *   2. Re-invoke `runChatLoop` against the updated history.
   *
   * The substrate stub is intentionally skipped on suspend (the turn
   * is not yet logically complete); the next runChatLoop call writes
   * it when the turn actually terminates.
   *
   * `toolCallId` is the same id the chat-loop wrote on the pending
   * tool row; the answer-write path locates the row by it. `question`
   * and `options` are forwarded so the UI doesn't have to re-parse
   * the persisted content on the same-tab happy path.
   */
  awaitingUserAnswer: {
    toolCallId: string;
    question: string;
    options: { label: string; description: string }[];
  } | null;
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
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
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
function extractUserText(msg: VeniceMessage | undefined): string {
  if (!msg || msg.role !== 'user') return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  return c
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Drive one user turn through as many rounds as the model asks for
 * (capped at MAX_ROUNDS). The function returns when the assistant
 * produces a terminal response (no tool_calls) or the cap trips.
 */
export async function runChatLoop(opts: ChatLoopOptions): Promise<ChatLoopResult> {
  const {
    venice,
    supabase,
    thread,
    userId,
    modelId,
    signal,
    handlers,
    reasoningEffort,
    disableThinking,
    verbosity,
    emphasisMarkdown,
    displayTimezone,
    lastAssistantTimestamp,
    userMessageId,
    userName,
    userLocation,
    intuitionModelId,
    intuitionMood,
    contextRecallEnabled,
    currentTurnHasAttachments,
  } = opts;
  // Copy so we can extend locally each round without mutating the caller.
  const history: VeniceMessage[] = [...opts.history];
  // Snapshot the thread's current toolbox set. Mutated in the loop
  // whenever the model calls `toggle_toolbox` so later rounds see the
  // new wire catalog. Returned to the caller at the end for local
  // state rehydration.
  let toolboxesEnabled: readonly string[] = thread.toolboxes_enabled;
  let finalText = '';
  let roundsRun = 0;
  let stoppedByLimit = false;
  let interrupted = false;
  let conflictDetected = false;
  // Non-null when an ask_user tool call landed this turn and the
  // loop is suspending to wait for the user's answer. Returned to the
  // caller (Chat.svelte) so the UI can flip into "awaiting answer"
  // mode. See ChatLoopResult.awaitingUserAnswer for the contract on
  // what the caller does next.
  let awaitingUserAnswer: ChatLoopResult['awaitingUserAnswer'] = null;
  // Track the last assistant row we persisted across rounds. End-of-
  // turn samskara substrate writes pair the opening user message with
  // whichever assistant row closed the turn — final text or terminal
  // tool-using row, whichever the loop ends on.
  let lastAssistantId: string | null = null;

  // Turn-open priming. Computed ONCE before the round loop so every
  // round in this turn sees the same compound + fire + opening-recall
  // block - the user's input doesn't change across rounds, and
  // recomputing per round would burn embedding calls and confuse the
  // cohort tracking (one cohort id per user turn, not per round).
  //
  // Three pieces run in parallel:
  //   1. Samskara compound summary (cached prose row, fast SELECT).
  //   2. Samskara fire (one embed + one cosine RPC + one log write).
  //   3. Opening-turn memory recall (one embed + one scored cosine
  //      RPC). Gated on "is this the first assistant turn of this
  //      thread?" so mid-conversation turns don't pay the tax. The
  //      model handles later-turn recall itself via the memory_recall
  //      tool, so auto-injection on every turn would be double work.
  //
  // Any piece may resolve to null/empty; the formatter and the
  // conditional history.push below render whatever sections are
  // present. Errors are already swallowed inside each helper - a
  // priming failure should never block a chat turn.
  //
  // Bounded wait. All three calls race the same timeout. The cosine
  // fire involves one Venice embed plus one Supabase RPC; the
  // compound summary is a single SELECT; the opening recall is one
  // embed plus one RPC. Common case lands in 100-300 ms. Cap at
  // SAMSKARA_PRIMING_TIMEOUT_MS so a slow Venice doesn't add visible
  // latency to the user's first token. The underlying Promises keep
  // running on timeout so the fire-log RPC inside fireSamskaras still
  // completes - the worst case is one cohort logged but never
  // reaction-classified, which the worker's resolution-window
  // discards naturally.
  const userText = extractUserText(history[history.length - 1]);
  // User-round index for the current turn (1-based count of user
  // messages in history, including the just-sent one). Hoisted up
  // here from its later use because fireSamskaras now persists this
  // value on every cohort fire so the per-message inline UI can
  // anchor each cohort to the user message that triggered it. The
  // count includes the current user message because history's last
  // element is that message at this point in the loop.
  const currentUserRound = countUserRounds(history);
  // Samskara priming bundle: compound summary (always-on across
  // turns) + situational fire (top-k for THIS user text). Both
  // resolve to potentially-null `<think>` block bodies; the chat-loop
  // pushes them as separate assistant <think> messages after the
  // user turn. Cold-start threads (no formation rows yet) produce
  // both-null and skip the pushes entirely.
  //
  // The old opening-recall pipeline used to ride alongside this
  // bundle on the opening turn. Context-recall now covers the
  // cold-start memory-pull job (memory_recall, conversation_recall,
  // wiki_recall children stitched into one note), leaving the
  // priming bundle smaller and the wire shape simpler.
  interface PrimingBundle {
    compoundThink: string | null;
    fireThink: string | null;
  }
  // Bracket a subconscious-priming pipeline's promise with the UI
  // start/end signals. Start fires synchronously (the throbber should
  // appear the instant the pipeline is kicked off, not a microtask
  // later); End fires when the promise settles, success or failure -
  // the row tracks liveness, not outcome. No-op when handlers is
  // absent. Returns the same promise so call sites read as a thin
  // wrapper around the underlying work.
  const trackSubconscious = <T>(op: SubconsciousOp, work: Promise<T>): Promise<T> => {
    handlers?.onSubconsciousStart?.(op);
    return work.finally(() => handlers?.onSubconsciousEnd?.(op));
  };

  const primingWork = (async (): Promise<PrimingBundle> => {
    const [compoundSummary, fireResult] = await Promise.all([
      getCompoundSummary(supabase),
      trackSubconscious(
        'samskara',
        fireSamskaras(supabase, thread.id, currentUserRound, userText, signal)
      ),
    ]);
    const { compound, fire } = formatPrimingThinks({
      compoundSummary,
      fire: fireResult as FireResult | null,
    });
    return { compoundThink: compound, fireThink: fire };
  })();
  const priming = await Promise.race<PrimingBundle>([
    primingWork,
    new Promise<PrimingBundle>((resolve) =>
      setTimeout(
        () => resolve({ compoundThink: null, fireThink: null }),
        SAMSKARA_PRIMING_TIMEOUT_MS,
      ),
    ),
  ]);

  // Per-turn thread-attachments inventory. Lists every file attached
  // anywhere in the conversation by category (live images, live
  // documents, expired) so the model has a holistic view rather than
  // having to scan every prior user turn for inline notes. The query
  // is a single thread-scoped SELECT against `message_attachments` and
  // doesn't go through Venice, so it stays out of the priming race and
  // its associated timeout. Failure is swallowed - the model falls
  // back to the per-message inline note rendered by
  // buildUserVeniceContent, same as before this block existed.
  const attachmentSummaries: ThreadAttachmentSummary[] = await supabase
    .listAttachmentSummariesForThread(thread.id)
    .catch(() => []);

  // Bias-profile block. One cached SELECT against bias_summary; null
  // on cold start (no observations yet) or when no row clears the
  // elided tier. The block rides at the end of the baseline system
  // prompt rather than as a per-turn ambient context message because
  // the profile is a slowly-changing structural claim about the user,
  // not turn-specific weather. Read once at turn entry; reused across
  // every round of this turn. Errors are swallowed inside
  // getBiasProfileBlock; `activeBiases` is the set that actually
  // rendered (post tier filter, post render cap) and feeds the v2
  // snapshot write below.
  const { block: biasProfileBlock, activeBiases: biasActiveBiases } =
    await getBiasProfileBlock(supabase);

  // Bias-profile invalidation. Each chat-loop invocation corresponds
  // to one new user message on this thread. If the thread had been
  // processed by the bias worker before, the worker's prior
  // observations are now based on a stale view of the conversation;
  // clear them. The RPC is a no-op when the thread was never
  // processed, so calling unconditionally is correct and cheap.
  // Fire-and-forget: bias worker plumbing must never block a chat
  // turn.
  void notifyBiasNewUserMessage(supabase, thread.id);

  // Bias-profile active-set snapshot (v2). Persist the bias keys
  // that just rendered into the system prompt to
  // threads.bias_active_at_turn so the worker's reactor pass knows
  // which biases the user's messages on this turn could have been
  // reacting to. Empty array is a valid write and means "no
  // compensation guidance was active this turn" - the reactor
  // pass produces zero rows and the feedback EMA stays unchanged.
  // Fire-and-forget; errors swallowed inside the helper.
  void snapshotBiasActiveBiases(supabase, thread.id, biasActiveBiases);

  // Subconscious-priming layer: two parallel pipelines, fired on the
  // same trigger machinery (cold-start, mid-turn title shift, mood
  // shift, stale fuse) but writing to independent caches and producing
  // independent synthetic <think> blocks.
  //
  //   1. Intuition (perception + 5 drives + synthesis). Cache lives on
  //      threads.intuition_payload. Skipped entirely when
  //      `intuitionModelId` is absent.
  //   2. Context recall (memory_recall + conversation_recall stitched
  //      into one note). Cache lives on threads.context_recall_payload.
  //      Skipped entirely when `contextRecallEnabled` is false/absent.
  //
  // Both pipelines read the trigger evaluator independently: each
  // payload carries its own `computed_at_round`, so the same-round
  // debounce works per-cache and a turn that already refreshed one
  // pipeline can still fire the other. When both fire on the same
  // trigger evaluation we run them in parallel via Promise.all - the
  // wall-clock cost is max(intuition, context-recall) plus one
  // Promise.all on the persist writes, not additive.
  //
  // `currentUserRound` is computed up at the top of this function
  // (before priming) because fireSamskaras now needs it to anchor
  // each cohort to a user-message round. Tool-using rounds inflate
  // the chat-loop's internal `round` counter but do not change this
  // value - one user message, one round id, regardless of how many
  // tool calls happen during the response.
  let intuitionCache: IntuitionPayload | null = readIntuitionCache(thread);
  let contextRecallCache: ContextRecallPayload | null =
    readContextRecallCache(thread);

  const intuitionPreTrigger =
    intuitionModelId !== undefined
      ? evaluatePreRoundTrigger({
          cache: intuitionCache,
          round: currentUserRound,
          mood: intuitionMood ?? null,
        })
      : null;
  const contextRecallPreTrigger = contextRecallEnabled
    ? evaluatePreRoundTrigger({
        // ContextRecallPayload satisfies RoundCacheSnapshot
        // structurally - the trigger evaluator only reads the round
        // and mood-snapshot fields, both shared between payloads.
        cache: contextRecallCache,
        round: currentUserRound,
        mood: intuitionMood ?? null,
      })
    : null;

  if (intuitionPreTrigger || contextRecallPreTrigger) {
    // Fire both pipelines in parallel. Each side resolves to either a
    // fresh payload or null (the agent failed, OR its trigger was
    // null and we short-circuited). Promise.all preserves the parallel
    // latency win even when one side short-circuits.
    const [freshIntuition, freshContextRecall] = await Promise.all([
      intuitionPreTrigger && intuitionModelId
        ? trackSubconscious(
            'intuition',
            withIntuitionInflight(thread.id, () =>
              runIntuitionPipeline({
                supabase,
                model: intuitionModelId,
                history,
                signal,
                round: currentUserRound,
                mood: intuitionMood ?? null,
                trigger: intuitionPreTrigger,
              })
            )
          )
        : Promise.resolve<IntuitionPayload | null>(null),
      contextRecallPreTrigger
        ? trackSubconscious(
            'recall',
            withContextRecallInflight(thread.id, () =>
              runContextRecallPipeline({
                supabase,
                threadId: thread.id,
                userId,
                signal,
                round: currentUserRound,
                mood: intuitionMood ?? null,
                trigger: contextRecallPreTrigger,
              })
            )
          )
        : Promise.resolve<ContextRecallPayload | null>(null),
    ]);

    // Persist both writes in parallel. The await-before-continuing
    // rationale on the existing intuition write applies symmetrically
    // to context-recall: a race against an unrelated thread UPDATE
    // (an update_title call mid-turn, a samskara-worker bump, a
    // cross-tab edit) could otherwise strand a fresh payload behind a
    // stale realtime echo. Cost is ~50-200ms of one Supabase UPDATE
    // each, parallel-merged into one wait.
    const persistOps: Promise<void>[] = [];
    if (freshIntuition) {
      intuitionCache = freshIntuition;
      persistOps.push(
        writeIntuitionCache(supabase, thread.id, freshIntuition)
      );
    }
    if (freshContextRecall) {
      contextRecallCache = freshContextRecall;
      persistOps.push(
        writeContextRecallCache(supabase, thread.id, freshContextRecall)
      );
    }
    if (persistOps.length > 0) await Promise.all(persistOps);

    // UI handlers fire AFTER the writes settle - same ordering the
    // prior intuition-only path enforced, for the same reason: a
    // realtime echo that arrives between the patch and the write must
    // see the persisted payload, not a transient null.
    if (freshIntuition) handlers?.onIntuitionUpdate?.(freshIntuition);
    if (freshContextRecall)
      handlers?.onContextRecallUpdate?.(freshContextRecall);
  }

  // Inject the synthetic `<think>` priming chain. Order matters for how
  // the model reads its own internal layers, from broadest to most
  // turn-specific:
  //
  //   1. Context-recall - stitched first-person note across the three
  //      persistent layers (memories, prior conversations, wiki).
  //      Covers cold-start memory pull as well as mid-thread topic
  //      shifts; the old opening-recall pipeline retired in favor of
  //      letting context-recall handle the opening turn too.
  //   2. Samskara compound prose - the "current model of the user"
  //      summary the formation worker maintains across turns.
  //   3. Samskara situational fire - top-k predictions for THIS user
  //      turn, rendered as first-person observations with
  //      parenthetical confidence hedges.
  //   4. Intuition synthesis - the most-processed layer (perception +
  //      5 drives + synthesis), reads cleanly as the last think block.
  //      The per-turn metadata system row rides after this whole chain
  //      (see the request assembly below), so a trailing system block
  //      follows intuition even though it is the final <think>.
  //
  // Each push is conditional: an empty-note context-recall, a
  // cold-start thread with no compound summary, a turn where the fire
  // top-k came back empty, an intuition-disabled thread - any of those
  // skips its push so we never burn tokens on an empty `<think>` block.
  if (contextRecallCache) {
    const msg = buildContextRecallThinkMessage(contextRecallCache);
    if (msg !== null) history.push(msg);
  }
  if (priming.compoundThink !== null) {
    history.push({
      role: 'assistant',
      content: `<think>\n${priming.compoundThink}\n</think>`,
    });
  }
  if (priming.fireThink !== null) {
    history.push({
      role: 'assistant',
      content: `<think>\n${priming.fireThink}\n</think>`,
    });
  }
  if (intuitionCache) {
    history.push(buildIntuitionThinkMessage(intuitionCache));
  }

  // System-prompt assembly with the per-turn metadata pinned LAST.
  // The baseline prompt (identity, voice, recall framing, toolbox
  // catalog) leads; user-configured system prompts from Settings
  // ride next so a custom "you are a pirate" prompt still wins on
  // voice while the baseline tool framing stays in force; then the
  // whole conversation; then the per-turn metadata system message as
  // the final row, immediately before the model generates.
  //
  // Metadata rides at the tail for prompt-cache economics, not
  // reading order. Venice - like every OpenAI-compatible backend -
  // can only reuse a cached prefix that is byte-identical from token
  // 0, and this block carries a wall-clock timestamp that changes
  // every turn. Positioned ahead of the conversation (where it used
  // to sit) it pushed the first-differing byte to the top of the
  // transcript, so the entire history had to be re-encoded on every
  // turn and every tool round - the conversation never cached.
  // Pinned after the conversation, the stable baseline + user-system
  // + growing history form a cacheable prefix; only this small
  // trailing block falls outside the cache (along with the
  // regenerated <think> priming, which is volatile turn-to-turn
  // regardless). The timestamp is minute-granular (see
  // buildDatetimeParagraph) so multiple tool rounds inside the same
  // minute keep even this trailing block byte-stable.
  //
  // Tradeoff accepted deliberately: the model reads ambient context
  // (datetime, attachments inventory, title and emphasis nudges)
  // AFTER its <think> priming chain rather than just before the user
  // turn, and the final wire row is role:system rather than the
  // intuition <think>. The user message still rides bare - no
  // `<user_message>` fence, no `<datetime>` tag, no
  // `<system_reminder>` directive; the role:user / role:system
  // boundary is the structural signal.
  //
  // The metadata message is built once per turn here. Multi-round
  // tool chains live entirely server-side, so the browser-side
  // wall-clock refresh between rounds the previous loop did is gone
  // (the server's getStreamingResponse round chain reuses the same
  // baton it was handed in the envelope POST). The title nudge
  // captures the title at turn entry; a mid-turn update_title call
  // lands in DB but doesn't re-render here - any next-turn priming
  // picks it up on its next user message.
  const { userSystem, conversation } = splitSystemPreamble(history);
  const metadataMessage = buildMetadataSystemMessage({
    userName,
    userLocation,
    displayTimezone,
    lastAssistantTimestamp,
    attachmentSummaries,
    currentTurnHasAttachments: currentTurnHasAttachments ?? false,
    emphasisMarkdown,
    threadTitle: thread.title,
    titleManuallySet: thread.title_manually_set,
    currentUserRound,
  });
  // Per-model chat-template quirk: some models (mistral-small-2603
  // today) reject an assistant-tail wire shape with "Cannot set
  // add_generation_prompt to True when the last message is from the
  // assistant." Nak's priming chain ends in assistant <think> blocks
  // (recall / samskara / intuition), which trips the rejection on
  // those models. When the model is flagged, append a single empty
  // user message after the conversation block so the template has
  // a user-tail to anchor on. The empty user adds ~1 token of
  // context and the model reads it as a continuation cue. Models
  // without the flag (deepseek, qwen, etc.) skip this entirely and
  // their wire shape stays unchanged.
  const modelSpec = (MODELS as Record<string, { chatTemplateRequiresUserTail?: boolean }>)[modelId];
  const conversationEndsInAssistant =
    conversation.length > 0 &&
    conversation[conversation.length - 1].role === 'assistant';
  const needsUserTailMarker =
    modelSpec?.chatTemplateRequiresUserTail === true &&
    conversationEndsInAssistant;
  const requestMessages: VeniceMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        // Pass the thread's current gated-toolbox set so the catalog
        // block renders [x]/[ ] marks that match what the model will
        // actually see on the wire this turn. Server-side tools may
        // flip the set via toggle_toolbox mid-turn; the realtime echo
        // updates the thread row asynchronously, so this is the
        // turn-entry snapshot.
        enabledToolboxes: toolboxesEnabled,
        biasProfile: biasProfileBlock,
      }),
    },
    ...userSystem,
    ...conversation,
    ...(needsUserTailMarker ? [{ role: 'user' as const, content: '' }] : []),
    metadataMessage,
  ];

  const consumed = await consumeStreamEvents({
    events: venice.streamChat({
      model: modelId,
      messages: requestMessages,
      signal,
      tools: buildToolList(toolboxesEnabled),
      reasoningEffort,
      disableThinking,
      verbosity,
      streamCtx: { threadId: thread.id, userMessageId },
    }),
    signal,
    supabase,
    handlers,
  });
  interrupted = consumed.interrupted;
  conflictDetected = consumed.conflictDetected;
  stoppedByLimit = consumed.stoppedByLimit;
  awaitingUserAnswer = consumed.awaitingUserAnswer;
  lastAssistantId = consumed.lastAssistantId;
  finalText = consumed.finalText;
  roundsRun = consumed.roundsRun;

  // Samskara substrate stub. Written once per turn after the loop
  // settles, paired with whichever assistant row closed the turn.
  // Fire-and-forget: a substrate write failure is logged inside
  // `recordSubstrateStub` but not surfaced — the formation pipeline
  // simply has fewer rows to work from until the next round writes
  // successfully. Skipped when the caller didn't supply
  // userMessageId (older callers, tests) or when no assistant row
  // landed at all (early abort, error path). Also skipped when the
  // loop is suspended on an ask_user pending answer - the turn is
  // not logically complete, the formation pipeline shouldn't see a
  // half-finished round, and the next runChatLoop call (post-answer)
  // will re-enter this path with the same userMessageId and write
  // the stub then.
  if (
    userMessageId &&
    lastAssistantId !== null &&
    awaitingUserAnswer === null
  ) {
    void recordSubstrateStub(supabase, thread.id, userMessageId, lastAssistantId);
  }

  return {
    finalText,
    roundsRun,
    stoppedByLimit,
    interrupted,
    conflictDetected,
    toolboxesEnabled,
    awaitingUserAnswer,
  };
}

/**
 * What `consumeStreamEvents` carries back to its caller. Mirrors the
 * tail half of `ChatLoopResult` - the bits that key off the END event
 * and the streaming accumulators. Both `runChatLoop` (live turn) and
 * `runReconnectLoop` (observing an in-flight or stale turn) project
 * this into their own return shape.
 */
interface ConsumedStreamResult {
  finalText: string;
  roundsRun: number;
  interrupted: boolean;
  conflictDetected: boolean;
  /**
   * Set when the server-side round loop exhausted MAX_ROUNDS without
   * the model ever producing a terminal text round. The END event
   * carries `terminalKind: 'error', conflict: 'round_limit'`; the
   * caller branches off this flag rather than digging through the raw
   * terminal kind + conflict tuple. Mutually exclusive with
   * `conflictDetected` (the other 'error' terminal source - a
   * commit_assistant_message race - flips that flag instead).
   */
  stoppedByLimit: boolean;
  awaitingUserAnswer: ChatLoopResult['awaitingUserAnswer'];
  lastAssistantId: string | null;
  terminalKind:
    | 'completed'
    | 'aborted'
    | 'error'
    | 'suspended_for_ask_user'
    | null;
}

/**
 * Drive the live UI off a `streamChat`-shaped event iterator. Owns
 * the streaming-bubble accumulators, the per-call ask_user capture,
 * the rate-limit / guard-retry liveness pairs, and the END routing
 * that maps the server's terminalKind back onto the legacy
 * interrupted / conflict / awaitingUserAnswer flags the caller's UI
 * still keys off.
 *
 * Two entry points feed this:
 * - `runChatLoop` (live turn, originating user message + priming +
 *   `venice.streamChat`).
 * - `runReconnectLoop` (passive observation of an in-flight turn,
 *   `streamReconnect` envelope + Broadcast channel).
 *
 * The function throws on a terminal 'error' END with no conflict
 * reason - the caller's outer try/catch surfaces the error banner.
 * Conflict-tagged errors translate into `conflictDetected = true`
 * and resolve normally.
 */
async function consumeStreamEvents(opts: {
  events: AsyncIterable<StreamEvent>;
  signal: AbortSignal;
  supabase: SupabaseService;
  handlers?: ChatLoopHandlers;
}): Promise<ConsumedStreamResult> {
  const { events, signal, supabase, handlers } = opts;

  // ask_user request capture. The model emits a tool_call_request for
  // ask_user with the question + options as its args; we parse them
  // here so an END {terminalKind: 'suspended_for_ask_user'} can return
  // the question/options to the caller without a separate fetch. Only
  // the FIRST ask_user call captures - sibling ask_user calls are
  // marked cancelled server-side.
  let pendingAskUser: ChatLoopResult['awaitingUserAnswer'] = null;

  // Server-driven END marker. Populated by the END event and consumed
  // after the loop closes; null when the stream never reached an END
  // (caught error / aborted-before-end). roundsRun is the
  // orchestrator's per-turn counter; we default to null and fall back
  // to a coarse 0/1 signal if the END event predates the field (older
  // server vs newer browser).
  let endPersistedId: string | null = null;
  let endTerminalKind: ConsumedStreamResult['terminalKind'] = null;
  let endConflict: string | undefined;
  let endRoundsRun: number | null = null;

  // Track the in-flight calls keyed by id so a tool_call_response can
  // pair to the originating tool_call request for the UI's per-tool
  // timing/state machinery. The server publishes tool_call_response
  // separately from tool_call_request; the browser doesn't execute
  // tools anymore, just reflects status.
  const pendingCallsById = new Map<string, OpenAIToolCall>();

  // Round-counter shim for output-guard retries. The server publishes
  // guard_retry events with a reason string; the UI handler expects an
  // attempt count, so we keep one locally.
  let guardAttemptCount = 0;

  // Accumulators for streaming feedback. The server is the source of
  // truth for the persisted assistant row; these drive the live
  // streaming bubble + reasoning panel + citation panel rendering
  // until END arrives, then feed the synthesized Message we hand to
  // onAssistantPersisted so the slot's persistedRows replay buffer
  // carries a row regardless of whether the realtime echo has landed.
  let streamingText = '';
  let streamingReasoning = '';
  let streamingCitations: Citation[] | null = null;
  let streamingUsage: TokenUsage | null = null;

  let interrupted = false;
  let conflictDetected = false;

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'text':
          streamingText += ev.delta;
          handlers?.onTextUpdate?.(streamingText);
          break;
        case 'reasoning':
          streamingReasoning += ev.delta;
          handlers?.onReasoningUpdate?.(streamingReasoning);
          break;
        case 'tool_call': {
          pendingCallsById.set(ev.toolCall.id, ev.toolCall);
          handlers?.onToolStart?.(ev.toolCall);
          // Capture the ask_user question + options off the request
          // args so an END {terminalKind: 'suspended_for_ask_user'}
          // can return them without re-fetching the persisted tool
          // row. The server enforces the first-call-wins suspend
          // rule; we mirror that here by only writing pendingAskUser
          // when the slot is empty.
          if (
            ev.toolCall.function.name === askUser.name &&
            pendingAskUser === null
          ) {
            try {
              const a = parseToolArguments(
                ev.toolCall.function.arguments,
              ) as Record<string, unknown>;
              const question =
                typeof a.question === 'string' ? a.question : '';
              const rawOptions = Array.isArray(a.options) ? a.options : [];
              const options: AskUserOption[] = rawOptions
                .filter((o): o is { label: string; description: string } =>
                  !!o &&
                  typeof o === 'object' &&
                  typeof (o as { label?: unknown }).label === 'string' &&
                  typeof (o as { description?: unknown }).description ===
                    'string',
                )
                .map((o) => ({ label: o.label, description: o.description }));
              pendingAskUser = {
                toolCallId: ev.toolCall.id,
                question,
                options,
              };
            } catch {
              // Malformed args from the model. The server will surface
              // this as a tool-error row and the model gets a chance to
              // recover on the next round. UI just doesn't get the
              // pre-populated AskUserCard data.
            }
          }
          break;
        }
        case 'tool_call_response': {
          // The server-side dispatcher finished executing the tool and
          // wrote its result row. Route to onToolDone (success) or
          // onToolError (failure) based on the wire ev.ok flag - the
          // tool-result row travels via the separate messages
          // realtime subscription with its own propagation latency,
          // and the in-card status icon (statusFor) consults the
          // per-call timing's `error` flag to render success vs
          // failure during the window where the row hasn't arrived
          // yet. ev.resultSummary is a preview the UI doesn't read
          // today but is wired through for forward compatibility.
          const call = pendingCallsById.get(ev.id);
          if (call) {
            if (ev.ok) {
              handlers?.onToolDone?.(call, ev.resultSummary);
            } else {
              // The error shape on the wire is the truncated summary
              // string ('{"ok":false,"error":{"message":"..."}}' from
              // the orchestrator). The full payload lives on the
              // tool-result row; this Error is a synthetic wrapper so
              // the handler's signature stays Error-typed.
              handlers?.onToolError?.(call, new Error(ev.resultSummary));
            }
          }
          break;
        }
        case 'usage':
          streamingUsage = ev.usage;
          break;
        case 'citations':
          streamingCitations = ev.citations;
          break;
        case 'rate_limit_wait': {
          // The wire carries an ISO 8601 timestamp; the UI handler
          // wants epoch ms for a countdown render.
          const untilMs = Date.parse(ev.until);
          handlers?.onRateLimitWait?.({
            retryAfterMs: ev.retryAfterMs,
            attempt: ev.attempt,
            until: Number.isFinite(untilMs)
              ? untilMs
              : Date.now() + ev.retryAfterMs,
          });
          break;
        }
        case 'rate_limit_resolved':
          handlers?.onRateLimitResolved?.();
          break;
        case 'guard_retry': {
          guardAttemptCount += 1;
          handlers?.onGuardRetry?.({
            guard: ev.reason || 'guard',
            attempt: guardAttemptCount,
          });
          // The discarded attempt's buffered text/reasoning must be
          // cleared so the re-roll renders into a clean streaming
          // bubble. The server discards the same prefix on its end.
          streamingText = '';
          streamingReasoning = '';
          break;
        }
        case 'stream_retry': {
          // Transport-layer retry. Server's withRateLimitRetry caught
          // a truncated SSE stream and is re-issuing the same body;
          // the consumer's accumulated content/reasoning belong to
          // the cut-off prefix and must be discarded so the new
          // attempt's stream renders cleanly. No UI affordance fires
          // (this is a silent recovery, unlike guard_retry which
          // raises a slop-notice card); the streaming bubble just
          // resets to empty and starts collecting again.
          streamingText = '';
          streamingReasoning = '';
          handlers?.onTextUpdate?.('');
          handlers?.onReasoningUpdate?.('');
          break;
        }
        case 'error':
          // The server reported a terminal stream failure. Throw with
          // a kind matching the original VeniceError categorization so
          // the outer try/catch surfaces a recognisable shape.
          throw new VeniceError(
            ev.message || 'stream error',
            ev.kind === 'rate_limit' ? 'rate_limit' : 'http',
          );
        case 'end':
          endPersistedId =
            ev.persistedAssistantId.length > 0
              ? ev.persistedAssistantId
              : null;
          endTerminalKind = ev.terminalKind;
          endConflict = ev.conflict;
          endRoundsRun = typeof ev.roundsRun === 'number' ? ev.roundsRun : null;
          break;
      }
    }
  } catch (err) {
    // User clicked the stop button (or the caller aborted for any
    // other reason) while the stream consumer was still reading.
    // The server-side function continues running until our control-
    // channel cancel publish reaches it; both paths drive END
    // {terminalKind: 'aborted'} eventually. Locally we just stop
    // consuming and flag interrupted - the server owns persistence.
    const isAbort =
      signal.aborted || (err instanceof Error && err.name === 'AbortError');
    if (!isAbort) throw err;
    interrupted = true;
  }

  // END routing. terminalKind is the canonical signal from the server;
  // the local catch above only sets interrupted when the consumer
  // never saw END. Translate each terminal kind into the legacy
  // ChatLoopResult fields the caller expects.
  if (endTerminalKind === 'aborted') {
    interrupted = true;
  }
  // Default state - flipped below if the END routing puts us into a
  // round-limit terminal.
  let stoppedByLimit = false;
  if (endTerminalKind === 'error') {
    // Server-side END error routing. Three sources today:
    //   - conflict='round_limit' - the orchestrator's round loop
    //     exhausted MAX_ROUNDS without the model ever producing a
    //     terminal text round. Map onto stoppedByLimit so the caller
    //     can render the "Stopped: hit the 20-round limit" banner.
    //   - conflict=<commit_assistant_message reason> - the assistant
    //     commit RPC saw a newer user message land underneath us, or
    //     another conversation-level race. Map onto the legacy
    //     conflictDetected path so the "conversation changed on
    //     another device" UI fires.
    //   - no conflict - generic stream error that already published
    //     an END (vs the mid-stream 'error' event which throws).
    //     Surface as a thrown error so the caller's error banner shows.
    if (endConflict === 'round_limit') {
      stoppedByLimit = true;
    } else if (endConflict) {
      conflictDetected = true;
    } else {
      throw new VeniceError(
        `stream ended in error state${endConflict ? `: ${endConflict}` : ''}`,
        'http',
      );
    }
  }
  const awaitingUserAnswer =
    endTerminalKind === 'suspended_for_ask_user' && pendingAskUser
      ? pendingAskUser
      : null;
  const lastAssistantId = endPersistedId;
  // Server-driven roundsRun when the END event carried it; coarse
  // fallback ("did anything run" vs nothing) for older server builds
  // that don't publish the field.
  const roundsRun = endRoundsRun ?? (endTerminalKind !== null ? 1 : 0);

  // Hydrate the persisted assistant row so the slot's persistedRows
  // replay buffer carries a canonical record. The realtime UPDATE
  // echo also delivers this row to subscribeToMessages, but exchanges
  // on a non-active thread won't have a live subscription - and the
  // slot's replay buffer is what populates `messages` on thread
  // re-entry. Best-effort: if the fetch fails the realtime path will
  // eventually catch up via the next listMessages.
  if (lastAssistantId !== null) {
    try {
      const msg = await supabase.getMessage(lastAssistantId);
      if (msg) handlers?.onAssistantPersisted?.(msg);
    } catch (err) {
      log.warn(
        `getMessage(${lastAssistantId}) failed; relying on realtime UPDATE: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Suppress unused-name warnings on the round-only state we used to
  // mutate. streamingCitations / streamingUsage land on the persisted
  // assistant row server-side; nothing on the browser consumes them
  // directly anymore.
  void streamingCitations;
  void streamingUsage;

  return {
    finalText: streamingText,
    roundsRun,
    interrupted,
    conflictDetected,
    stoppedByLimit,
    awaitingUserAnswer,
    lastAssistantId,
    terminalKind: endTerminalKind,
  };
}

/**
 * What `runReconnectLoop` carries back. A narrower shape than
 * `ChatLoopResult` because the priming layers, toolboxes-enabled
 * snapshot, and stoppedByLimit flag are inapplicable: priming never
 * fired (the live turn ran on the other side of the
 * background/reload), the toolboxes set lives on the thread row, and
 * the round-cap stop only matters to live-turn callers that branch on
 * it.
 */
export interface ReconnectLoopResult {
  finalText: string;
  interrupted: boolean;
  conflictDetected: boolean;
  awaitingUserAnswer: ChatLoopResult['awaitingUserAnswer'];
  noStreamInFlight: boolean;
}

export interface ReconnectLoopOptions {
  supabase: SupabaseService;
  threadId: string;
  signal: AbortSignal;
  handlers?: ChatLoopHandlers;
}

/**
 * Join an in-flight assistant turn the user is observing from a
 * fresh tab or peer device. Posts `/stream` with `reconnectOnly:
 * true` via `streamReconnect`, subscribes to the Broadcast channel,
 * and dispatches the wire events through the same handler surface as
 * a live turn so the streaming bubble, tool timings, and END
 * accounting work identically.
 *
 * When the server reports no in-flight stream the helper unwinds
 * cleanly with `noStreamInFlight: true`. The caller distinguishes
 * "stream is already done, render the terminal row" from "stream
 * died mid-flight, surface a retry affordance" off the row's status
 * column.
 */
export async function runReconnectLoop(
  opts: ReconnectLoopOptions,
): Promise<ReconnectLoopResult> {
  const { supabase, threadId, signal, handlers } = opts;

  // Reuse the same event consumer as runChatLoop so the streaming-
  // bubble accumulators, ask_user capture, rate-limit / guard
  // liveness pairs, END routing, and persisted-row hydration all
  // behave identically. The only divergence from a live turn is the
  // event source (streamReconnect rather than venice.streamChat) and
  // the lack of a substrate stub at the tail (the anchor user message
  // id isn't known on reconnect).
  const consumed = await consumeStreamEvents({
    events: streamReconnect(supabase.client, { threadId }, signal),
    signal,
    supabase,
    handlers,
  });

  // noStreamInFlight surfaces as a single END {terminalKind:
  // 'completed', persistedAssistantId: ''} in the consumer - the
  // envelope's noStreamInFlight branch in venice.ts yields exactly
  // that synthetic terminal event. Detect by the absence of a
  // persisted row id; a real completion always carries one.
  const noStreamInFlight =
    consumed.terminalKind === 'completed' &&
    consumed.lastAssistantId === null;

  return {
    finalText: consumed.finalText,
    interrupted: consumed.interrupted,
    conflictDetected: consumed.conflictDetected,
    awaitingUserAnswer: consumed.awaitingUserAnswer,
    noStreamInFlight,
  };
}

