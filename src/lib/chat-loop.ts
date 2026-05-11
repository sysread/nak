/**
 * Chat-loop orchestrator — runs one user turn from submission through to
 * a final assistant answer, including any tool-call rounds in between.
 *
 * One "round" = stream an assistant response → if it ended with
 * tool_calls, execute every call concurrently and append role='tool'
 * rows for each → start another round with the extended history. Loop
 * exits when an assistant response finishes with text and no
 * tool_calls, or when the MAX_ROUNDS guardrail trips.
 *
 * Split from Chat.svelte.send() so the orchestration logic is
 * unit-testable without a Svelte runtime, and so the UI (pt 4) can
 * consume a stable event stream rather than threading callbacks through
 * the component.
 *
 * Cancellation: every tool execution gets a child AbortController
 * linked to the outer `signal`. Aborting the outer cancels in-flight
 * fetch requests in both the streaming path and the tool path,
 * propagates as rejections in the per-tool promises, and those
 * rejections land as tool-result rows with error content — keeping the
 * persisted history internally consistent even on cancellation.
 *
 * Ordering of persistence within a round: assistant message first (so
 * the tool rows have a parent to reference in future replay), then
 * one tool-result row per call in the order the model returned them.
 */

import type { ReasoningEffort, Verbosity } from './models';
import type {
  SupabaseService,
  Message,
  Thread,
  ThreadAttachmentSummary,
} from './supabase';
import type {
  VeniceClient,
  VeniceMessage,
  TokenUsage,
  Citation,
  ChatRequest,
  StreamEvent,
} from './venice';
import { VeniceError } from './venice';
import { buildUserVeniceContent } from './attachments';
import {
  buildToolList,
  executeToolCall,
  toggleToolbox,
  updateTitle,
  type OpenAIToolCall,
  type ToolContext,
} from './tools';
import { buildSystemPrompt } from './chat-prompt';
import {
  parseToolArguments,
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
} from './tools/wire';
import {
  fireSamskaras,
  formatPriming,
  getCompoundSummary,
  recordSubstrateStub,
  type FireResult,
} from './samskara';
import { recallOpeningMemories } from './opening-recall';
import { detectTimezone, todayInZone } from './journal-day';
import type { JournalEntry } from './supabase';
import {
  buildIntuitionThinkMessage,
  countUserRounds,
  evaluatePreRoundTrigger,
  evaluateTitleTrigger,
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

/**
 * Upper bound on rounds to prevent a runaway tool-call loop. Acts as
 * a coarse backstop only - the real bound on agent recursion lives in
 * `tools/run.ts` as `MAX_AGENT_DEPTH`. Set generously so a legitimate
 * multi-tool turn (web_search, then a memory_recall pass, then a
 * cookbook write, then a final reply) doesn't bump into it; if a turn
 * actually hits the cap, the model is misbehaving rather than working.
 */
export const MAX_ROUNDS = 20;

/**
 * Hard cap on the wait for samskara priming before the first
 * assistant round starts. Common case lands well under this; the
 * cap exists so a slow Venice or a hiccup in the cosine RPC can't
 * add visible latency to the user's first token. Picked at 1500ms
 * because async chat tolerates a half-second send delay but not
 * more - anything beyond that and the user starts noticing.
 */
const SAMSKARA_PRIMING_TIMEOUT_MS = 1500;

/**
 * Boundary markers we splice around the current turn's user text when
 * Venice web search is active. Venice inlines its search payload plus
 * a framing instruction ("you can use this real time information to
 * answer the user's query above") into the user's turn server-side,
 * before the model ever sees it — and without a structural boundary
 * the model confuses the Venice injection for user-authored input
 * (observed: it started thanking the user for links they never sent
 * and quoting snippets back as if they were the user's words, with
 * the reasoning trace literally saying 'and the user says: "..."').
 *
 * Wrapping the user's real message gives the model an unambiguous
 * signal. The system prompt's web-search block (see buildSystemPrompt
 * in ./tools/index.ts) tells the model that only the text inside
 * these tags is from the human; anything outside — even though it
 * rides inside role=user on the wire — is platform-injected
 * reference material.
 */
const USER_MSG_OPEN = '<user_message>';
const USER_MSG_CLOSE = '</user_message>';

/** Placeholder string threads ship with from schema.sql + draft creation. */
const DEFAULT_THREAD_TITLE = 'New conversation';

/**
 * Low-urgency topic-drift nudge fed to the model via the system-prompt
 * appendix. Fires only on threads that already have a real,
 * model-picked title and where the user has not manually committed to
 * one - i.e. the case where renaming is a maybe rather than a must.
 * Kept terse because it rides every non-placeholder, non-manual turn
 * and is almost always a no-op; we don't want to pay tokens or prompt
 * weight for what amounts to a passive reminder that the tool exists.
 *
 * The placeholder case is NOT handled here - it lands as a separate
 * post-user system message via `buildTitleReminderMessage` below.
 * Putting an imperative "you must do X this turn" directive into the
 * baseline system prompt buries it above every later message in
 * `history`, and the model's instruction-following weakens with
 * distance from the generation point. A trailing system message lands
 * after the user's actual turn (and after any tool-result rows on
 * later rounds), which is the strongest position available.
 *
 * Returns null when the user has manually renamed the thread (so the
 * model never gets prompted to clobber a deliberate user choice) and
 * also when the title is still the placeholder (the post-user
 * reminder covers that case instead).
 */
function buildTitleAppendixNote(thread: Thread): string | null {
  if (thread.title_manually_set) return null;
  if (thread.title === DEFAULT_THREAD_TITLE) return null;
  return [
    `Current conversation title: "${thread.title}". If the topic has`,
    'meaningfully shifted, call `update_title` with a better 3-6 word',
    'title. Cosmetic drift is not a reason to rename.',
  ].join('\n');
}

/**
 * Build the per-turn placeholder-title nag. Returns the inner
 * directive content; the wrapping `<system_reminder>...</system_reminder>`
 * tags are added by `tagLastUserMessage` when it folds this string
 * into the latest user turn's content (outside the `<user_message>`
 * boundary). Returns null on placeholder-free threads (nothing to nag
 * about) and on manually-named threads (user already committed; the
 * model must not clobber their choice).
 *
 * Why fold this into the user turn rather than send it as a trailing
 * `role: 'system'` message: the trailing-system placement was the
 * design before this, and the model still missed it. Two plausible
 * causes - Venice / the underlying model collapsing consecutive
 * `role: 'system'` rows into the leading prompt, and "system goes at
 * index 0" being a strong enough training prior that a trailing system
 * row gets weighted poorly. Both are fixed by riding inside the user
 * turn: the user-role content is the position the model is guaranteed
 * to attend to, and the `<system_reminder>` tag combined with the
 * boundary rule in the system prompt keeps the directive distinct
 * from user-authored text.
 *
 * The inner block uses a markdown `##` header. The tag form was
 * considered and rejected for the inner content: a user typing
 * `</system_reminder>` would escape early and inject instructions. The
 * outer `<system_reminder>` wrapper has the same theoretical
 * vulnerability, but a user would have to type both `</user_message>`
 * AND a fake `<system_reminder>` block to inject - the same
 * pre-existing escape vector that already exists for `<datetime>`.
 */
function buildTitleReminderMessage(thread: Thread): string | null {
  if (thread.title_manually_set) return null;
  if (thread.title !== DEFAULT_THREAD_TITLE) return null;
  return [
    '## Required this turn: title this conversation',
    '',
    `The thread title is still the "${DEFAULT_THREAD_TITLE}"`,
    'placeholder. Before generating any reply to the user, call the',
    '`update_title` tool with a concise 3-6 word title describing',
    'what the user is actually asking about. If the opening message',
    'is a greeting or pleasantry, look past it to the real topic of',
    'the conversation - infer it from their message and from the',
    'reply you are about to write.',
    '',
    'This is not optional. Until you call `update_title`, the thread',
    "stays labelled as the placeholder in the user's conversation",
    'drawer - which is a visible bug. No trailing punctuation, no',
    'quotes, plain text.',
  ].join('\n');
}

/**
 * Opt-in formatting nudge for the model. When the user has the
 * "Emphasis markdown" setting on (Settings -> AI), chat-loop folds
 * this block into the per-turn system-prompt appendix so every
 * reply this turn carries the same instruction. The goal is a
 * bionic-style scan aid: bold on terms the reader should fix on,
 * italics on phrases that orient them, sparsity calibrated so the
 * emphasis rewards skimming instead of competing with it.
 *
 * Editing this copy changes model behaviour on every turn of every
 * user who has the toggle on - treat it as a voice-tuning change,
 * not a typo fix. Kept in a named function so the prompt text sits
 * next to the rules that shaped it rather than buried inline in
 * the appendix-build block.
 */
/**
 * Render the User profile block from the user's name + location
 * settings, or null when both are empty. Sits at the top of the
 * per-turn appendix so the model sees the user's identity before any
 * of the other ambient context (samskara priming, today's journal,
 * formatting nudges) - the framing rule for the rest of the appendix
 * is "this is who you're talking to," and that needs to land first.
 *
 * Both fields are free-form. We pass them through verbatim rather
 * than imposing a label/format so a user who wrote "they/them, based
 * in Lisbon" gets exactly that string rendered. The block is plain
 * text with a leading "## User profile" header so it visually
 * separates from the prose blocks that follow without competing
 * with them. Returns null when both fields are empty so a fresh
 * account that hasn't filled the form pays zero tokens.
 *
 * Editing this copy changes model behaviour on every turn of every
 * user who has either field set - treat it as a voice-tuning change.
 */
function buildUserProfileNote(
  name: string | null | undefined,
  location: string | null | undefined
): string | null {
  const trimmedName = (name ?? '').trim();
  const trimmedLocation = (location ?? '').trim();
  if (trimmedName.length === 0 && trimmedLocation.length === 0) return null;
  const lines: string[] = ['## User profile', ''];
  if (trimmedName.length > 0) lines.push(`Name: ${trimmedName}`);
  if (trimmedLocation.length > 0) lines.push(`Location: ${trimmedLocation}`);
  lines.push(
    '',
    'The user supplied this in Settings so you can address them',
    'naturally and ground location-specific answers (weather, local',
    'time, regional context) without asking back. Use it when it',
    "helps; don't recite it back at them or treat it as instruction."
  );
  return lines.join('\n');
}

function buildEmphasisNote(): string {
  return [
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
  ].join('\n');
}

/**
 * Render today's automatic journal entry as a short appendix block for
 * the system prompt. Returns null when there's no entry yet today or
 * when the caller passed no entry (mid-thread turns, the priming
 * timeout fell through, etc.).
 *
 * Design intent: the block is context, not instruction. The baseline
 * prompt already explains what the Journal is and how to use it -
 * this block just ships the actual content so the model can weave
 * continuity in. Kept compact: date header + topics/mood line + body.
 * No `###` heavy formatting because the appendix as a whole is
 * already framed as per-turn reference material, not an essay.
 */
function buildJournalNote(entry: JournalEntry | null): string | null {
  if (!entry) return null;
  const tags: string[] = [];
  if (entry.topics.length > 0) {
    tags.push(`topics: ${entry.topics.join(', ')}`);
  }
  if (entry.mood) tags.push(`mood: ${entry.mood}`);
  if (entry.people.length > 0) {
    tags.push(`people: ${entry.people.join(', ')}`);
  }
  const lines: string[] = [
    `## Today's journal (${entry.entry_date})`,
    '',
  ];
  if (tags.length > 0) {
    lines.push(`_${tags.join(' / ')}_`, '');
  }
  lines.push(entry.content);
  return lines.join('\n');
}

/**
 * Render the `<thread_attachments>` per-turn appendix block listing
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
 * Build the per-turn `<datetime>` tag that gets prepended to the
 * latest user turn (outside the `<user_message>` boundary, see
 * `tagLastUserMessage` below). The tag carries the wall-clock time
 * at request-build time in three forms:
 *
 *   - `local`: ISO 8601 with offset, computed in the user's
 *     `journalTimezone` (or the runtime's reported zone if the
 *     setting is unset). Friendly enough that the model can answer
 *     "what time is it?" or "what day of the week is it?" without
 *     guessing - it can read the offset, the date, and (via the
 *     date) the day of week directly.
 *   - `utc`: ISO 8601 Z form. Unambiguous reference time, included
 *     so the model has a fallback if it doesn't trust the local
 *     interpretation.
 *   - `zone`: the IANA zone name itself, so the model can name the
 *     timezone in replies ("it's 3pm in America/Los_Angeles") and
 *     so the value is self-describing if surfaced in logs.
 *
 * This exists because LLMs have no clock - the model was trained
 * months ago, and without an injected datetime it either refuses
 * "what year is it?" or hallucinates a stale answer. The tag rides
 * outside `<user_message>` so the boundary contract from the system
 * prompt applies: anything outside the tags is platform-injected
 * metadata, not human input the model should echo or thank the
 * user for.
 *
 * Computed fresh per round in the chat-loop, not once at send-time.
 * Multi-round tool loops can take 30+ seconds; recomputing every
 * round keeps the value honest if the model asks the user "what
 * time is it now?" mid-tool-loop on a long-running turn.
 */
function buildDatetimeTag(tz: string | null | undefined): string {
  const now = new Date();
  // Drop sub-second precision: noisy in the prompt and the model
  // doesn't use millisecond resolution for anything.
  const utc = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const zone = typeof tz === 'string' && tz.length > 0 ? tz : detectTimezone();
  let local = utc;
  let zoneAttr = zone;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
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
    local = `${get('year')}-${get('month')}-${get('day')}T${h}:${get('minute')}:${get('second')}${offset}`;
  } catch {
    // Unknown / rejected zone (older Safari has been stricter about
    // unfamiliar IANA names). Fall back to UTC for both forms - the
    // model still gets a usable timestamp, it just loses the local
    // calibration.
    zoneAttr = 'UTC';
  }
  return `<datetime local="${local}" utc="${utc}" zone="${zoneAttr}" />`;
}

/**
 * Return a shallow copy of `messages` with the last role='user'
 * message's content wrapped in the <user_message> boundary tags, a
 * `<datetime>` tag prepended outside that boundary, and an optional
 * `<system_reminder>` block appended outside the boundary on the
 * trailing side. The input messages are not mutated - we allocate a
 * fresh message object (and fresh content array, when the content is
 * multimodal) so that the caller's history stays untouched across the
 * chat loop's rounds.
 *
 * Scope is deliberately "last user turn only": that's the one Venice
 * augments on the current round, and that's where the freshest
 * datetime belongs. Earlier user turns in history were already
 * processed on prior rounds with their own then-current datetime;
 * re-tagging them with "now" would falsely imply the user said those
 * older words right now. Tagging every user turn in the request
 * would also bloat the wire and could confuse the model into
 * thinking the boundary tags carry per-turn semantics beyond "this
 * is where the human's words are."
 *
 * The `<datetime>` and `<system_reminder>` tags both sit OUTSIDE the
 * `<user_message>` fence on purpose: the system prompt's boundary
 * block tells the model that anything outside the fence is
 * platform-injected, which is exactly the role both tags play
 * (datetime is reference material; system_reminder is an actionable
 * platform directive - the system prompt teaches the distinction).
 * Putting either inside would make the model treat the tag text as
 * user-typed input.
 *
 * `trailingReminder` is the `buildTitleReminderMessage` output (or
 * any future per-turn directive that needs to land where the model
 * actually attends to it). Null on turns with nothing to nag about
 * (real model-set title, manually-named thread); the function then
 * skips the trailing tag entirely so non-placeholder turns don't pay
 * the token cost. Folding this into the user turn replaced an earlier
 * design that pushed it as a trailing `role: 'system'` message - that
 * placement was getting silently dropped or de-weighted on the wire,
 * leaving placeholder threads parked on "New conversation" across
 * many turns despite the directive being marked "not optional".
 */
function tagLastUserMessage(
  messages: VeniceMessage[],
  datetimeTag: string,
  trailingReminder: string | null,
): VeniceMessage[] {
  // Walk from the end so we find the most recent user message even
  // when tool-result rows follow it on a mid-loop round.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;
  const out = messages.slice();
  const orig = out[lastUserIdx];
  // Empty string when the caller passed null so the template
  // concatenations stay simple. The leading newline only lands when
  // the reminder is non-null, so non-placeholder turns don't pay a
  // stray blank line at the end of their user content.
  const reminderTrailer = trailingReminder
    ? `\n<system_reminder>\n${trailingReminder}\n</system_reminder>`
    : '';
  if (typeof orig.content === 'string') {
    out[lastUserIdx] = {
      ...orig,
      content: `${datetimeTag}\n${USER_MSG_OPEN}${orig.content}${USER_MSG_CLOSE}${reminderTrailer}`,
    };
  } else {
    // Vision/multimodal: prepend the datetime tag + opening-tag text
    // part and append a closing-tag text part so images and
    // extracted-text prelude blocks all sit *inside* the user-message
    // boundary while the datetime sits outside. Allocating a fresh
    // array so we don't mutate the caller's content. The trailing
    // reminder rides as another text part after the close tag, again
    // outside the boundary.
    const parts: typeof orig.content = [
      { type: 'text', text: `${datetimeTag}\n${USER_MSG_OPEN}` },
      ...orig.content,
      { type: 'text', text: USER_MSG_CLOSE },
    ];
    if (trailingReminder) {
      parts.push({ type: 'text', text: reminderTrailer });
    }
    out[lastUserIdx] = { ...orig, content: parts };
  }
  return out;
}

/**
 * Order-insensitive equality for two toolbox-name arrays. Used to
 * decide whether a `toggle_toolbox` result changed the thread's
 * effective set - if it didn't (the model toggled to the same
 * array), we skip the onToolboxesEnabledChange notification so the
 * UI doesn't flash for a no-op. The toolbox name list is tiny (< 10
 * entries) so the nested-loop cost is negligible.
 */
function sameToolboxSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  for (const name of a) {
    if (!bSet.has(name)) return false;
  }
  return true;
}

/**
 * Compose a child AbortController whose `.abort()` fires whenever the
 * parent signal aborts. Used to scope per-tool cancellation under the
 * outer send() signal: aborting the send cancels every in-flight tool
 * fetch as a side effect.
 */
function childController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) {
    child.abort(parent.reason);
    return child;
  }
  const onAbort = (): void => child.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return child;
}

/**
 * Maximum number of attempts (initial + retries) for a single round
 * before a Venice rate-limit error propagates to the caller. Picked
 * so a brief quota dip recovers transparently while a stuck quota
 * still surfaces as a visible failure rather than spinning forever.
 */
const RATE_LIMIT_MAX_ATTEMPTS = 3;
/**
 * Per-attempt fallback wait, used only when Venice's response carries
 * neither Retry-After nor x-ratelimit-reset-{requests,tokens}. Indexed
 * by attempt number minus one. Kept short - in practice Venice always
 * supplies a hint, and these are belt-and-braces values for a
 * provider misbehaviour.
 */
const RATE_LIMIT_FALLBACK_WAIT_MS = [2_000, 4_000];
/**
 * Hard cap on a single rate-limit wait. Venice quotas typically reset
 * within a minute; a Retry-After longer than this almost certainly
 * means the user has hit a daily/monthly cap that won't clear during
 * the session, so we surface it as an error and let the user retry
 * manually rather than block the UI for that long.
 */
const RATE_LIMIT_WAIT_CAP_MS = 60_000;

/**
 * Sleep that resolves either when `ms` elapses or when `signal` aborts.
 * Returns true if the signal interrupted the sleep, false on a clean
 * timeout. Caller decides what to do with an interrupted return - the
 * rate-limit retry path treats it as a cancel and aborts the round.
 */
function sleepCancellable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wrap venice.streamChat in a transparent rate-limit retry loop. When
 * Venice returns 429, sleep for the duration parsed from the response
 * headers (Retry-After, falling back to x-ratelimit-reset-*) and
 * re-issue the request. Caps at RATE_LIMIT_MAX_ATTEMPTS attempts; a
 * final 429 propagates as a VeniceError with kind 'rate_limit'.
 *
 * Retry only fires when no events have been yielded yet on the current
 * attempt. Venice's 429 path throws before the first yield (see the
 * !res.ok guard in venice.ts:streamChat), so in practice every retry
 * starts from a clean slate; the emitted-events guard is a defensive
 * invariant for future-proofing rather than a path we expect to hit.
 *
 * The wait is cancellable via `signal`. If the caller aborts during
 * the sleep, this generator throws an AbortError matching the shape
 * `fetch` raises on a normal mid-stream abort, so the caller's
 * existing AbortError branch handles it identically - the user's
 * cancel button works the same whether the round is mid-stream or
 * mid-rate-limit-wait.
 *
 * Fires `handlers.onRateLimitWait` immediately before each sleep and
 * `handlers.onRateLimitResolved` after the sleep ends (whether the
 * sleep timed out cleanly or the signal aborted). The UI uses this
 * pair to swap the streaming-bubble spinner for a "waiting on Venice"
 * indicator with a cancel button.
 */
async function* streamChatWithRateLimitRetry(
  venice: VeniceClient,
  req: ChatRequest,
  handlers: ChatLoopHandlers | undefined,
): AsyncGenerator<StreamEvent, void, void> {
  const signal = req.signal;
  if (!signal) {
    throw new Error('streamChatWithRateLimitRetry requires req.signal');
  }
  let attempt = 0;
  while (true) {
    let emitted = false;
    try {
      for await (const ev of venice.streamChat(req)) {
        emitted = true;
        yield ev;
      }
      return;
    } catch (err) {
      const isRateLimit =
        err instanceof VeniceError && err.kind === 'rate_limit';
      const retriesExhausted = attempt >= RATE_LIMIT_MAX_ATTEMPTS - 1;
      if (!isRateLimit || emitted || retriesExhausted || signal.aborted) {
        throw err;
      }
      attempt += 1;
      const hint = (err as VeniceError).retryAfterMs;
      const fallbackIdx = Math.min(
        attempt - 1,
        RATE_LIMIT_FALLBACK_WAIT_MS.length - 1
      );
      const baseMs = hint ?? RATE_LIMIT_FALLBACK_WAIT_MS[fallbackIdx];
      const waitMs = Math.min(baseMs, RATE_LIMIT_WAIT_CAP_MS);
      const until = Date.now() + waitMs;
      handlers?.onRateLimitWait?.({ retryAfterMs: hint, attempt, until });
      let interrupted = false;
      try {
        interrupted = await sleepCancellable(waitMs, signal);
      } finally {
        handlers?.onRateLimitResolved?.();
      }
      if (interrupted || signal.aborted) {
        // Abort during the wait. Throw a spec-shaped AbortError so the
        // caller's existing AbortError branch fires - same path the
        // stop button takes during a mid-stream abort, so the user
        // sees the same INTERRUPTED_MARKER outcome either way.
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      // Loop body runs again; emitted resets to false on the next pass.
    }
  }
}

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
   * When true, append a short formatting-nudge block to the per-turn
   * system-prompt appendix asking the model to sprinkle light
   * Markdown emphasis (bold terms, italic phrases) through its reply
   * as scan-points. Opt-in; the block is skipped when false/absent
   * so the baseline prompt stays free of formatting hints for users
   * who didn't ask for them. See `buildEmphasisNote` below for the
   * exact wording - modifying it changes model behaviour on every
   * turn of every user who has the toggle on.
   */
  emphasisMarkdown?: boolean;
  /**
   * Optional free-form display name + location the user entered in
   * Settings -> AI -> About you. When either is non-empty, chat-loop
   * folds a short "User profile" block into the per-turn system-
   * prompt appendix so every reply this turn sees the identity
   * context. Both empty / absent skips the block entirely so a fresh
   * account pays zero tokens. See `buildUserProfileNote` for the
   * exact rendered shape - editing that wording changes model
   * behaviour on every turn of every user who has filled the form.
   */
  userName?: string | null;
  userLocation?: string | null;
  /**
   * IANA timezone used to compute "today" for the Journal
   * appendix and the per-turn `<datetime>` tag prepended to the
   * latest user message (see `buildDatetimeTag`). When
   * null/undefined both paths fall back to the runtime's reported
   * zone (typically the browser's own). The journal use is
   * indirect (calendar-day bucketing); the datetime use is direct -
   * the model reads the local time off this zone, so a wrong value
   * here will surface as the model giving the user the wrong wall-
   * clock time.
   */
  journalTimezone?: string | null;
  /**
   * Optional id of the user message that opened this turn. When set,
   * the chat-loop pairs it with the terminal assistant message id and
   * writes a samskara substrate stub at end-of-round (the formation
   * worker enriches it later). When absent the substrate stub is
   * skipped — older callers and tests don't need to know about
   * samskara to keep working.
   */
  userMessageId?: string;
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
}

/**
 * Marker appended to the content field of an assistant row whose stream
 * the user cut short mid-response. Rendered verbatim in the message
 * bubble so the reader can tell a truncated reply from a naturally
 * short one. ASCII only and placed on its own line so a markdown
 * renderer treats it as paragraph text rather than a setext heading
 * (three hyphens alone would become an &lt;hr&gt; / H2; three hyphens
 * followed by more text on the same line parses as paragraph).
 */
export const INTERRUPTED_MARKER = '--- user interrupted response';

/**
 * Project a stored Message row onto the OpenAI wire format. Handles the
 * three shapes we emit: plain text (system/user/assistant-text), an
 * assistant row that invoked tools (`tool_calls` attached, content may
 * be empty), and a tool-result row (`role='tool'` with tool_call_id and
 * name).
 */
export function toVeniceMessage(
  m: Message,
  opts?: { visionSpec?: { supportsVision: boolean } }
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
      opts?.visionSpec ?? { supportsVision: false }
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
 * Encode a tool's return value (or error) into the string `content`
 * field that OpenAI's tool-result messages expect. Always JSON so the
 * model sees structured data rather than a toString rendering.
 */
function encodeToolContent(
  result: { ok: true; value: unknown } | { ok: false; error: Error }
): string {
  if (result.ok) {
    // Unknown values — stringify defensively so a thrown toString on a
    // weird object doesn't bubble up as a tool result.
    try {
      return JSON.stringify(result.value ?? null);
    } catch {
      return JSON.stringify({ error: 'result not serializable' });
    }
  }
  return JSON.stringify({ error: result.error.message || String(result.error) });
}

/**
 * Pick a `citations` array off a tool return value when the shape looks
 * like one. Used by the chat loop to harvest web-search sources out of
 * the `web_search` tool's `{answer, citations}` return and merge them
 * onto the terminal assistant row's `citations` column. The check is
 * structural rather than name-based so any future tool returning a
 * similarly shaped payload rides the same path without another branch.
 *
 * Defensive about the field shape: Venice's Citation requires `url`
 * and allows every other field to be absent, so we mirror that here.
 * Anything without a string `url` is skipped rather than silently
 * rendering an empty row.
 */
function extractToolCitations(value: unknown): Citation[] {
  if (!value || typeof value !== 'object') return [];
  const raw = (value as { citations?: unknown }).citations;
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.url !== 'string' || e.url.length === 0) continue;
    const cite: Citation = {
      // Placeholder index - the caller rewrites this to a running
      // 1-based global position so indexes stay contiguous across
      // multiple tool calls within a turn.
      index: 0,
      url: e.url,
    };
    if (typeof e.title === 'string') cite.title = e.title;
    if (typeof e.content === 'string') cite.content = e.content;
    if (typeof e.date === 'string') cite.date = e.date;
    out.push(cite);
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
    journalTimezone,
    userMessageId,
    userName,
    userLocation,
    intuitionModelId,
    intuitionMood,
    contextRecallEnabled,
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
  // Track the last assistant row we persisted across rounds. End-of-
  // turn samskara substrate writes pair the opening user message with
  // whichever assistant row closed the turn — final text or terminal
  // tool-using row, whichever the loop ends on.
  let lastAssistantId: string | null = null;

  // Citations sourced from tool results over the whole turn. Accumulated
  // across rounds with monotonic 1-based indexes so the rendered panel
  // reads 1,2,3,... regardless of how many `web_search` calls fired or
  // what per-call numbering each returned. Persisted on the terminal
  // assistant row when `roundCitations` (Venice's direct citations on
  // the outer stream) is empty - which is the common case now that the
  // main chat-loop no longer sets `enable_web_search` on its own
  // requests, so the only citation source is the tool path.
  const toolCitations: Citation[] = [];

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
  // "Opening turn" = no assistant messages in history yet. A fresh
  // thread on turn 1 matches; a thread where the user edited their
  // first message before any reply also matches (correctly - the
  // model still hasn't seen anything). Later turns fall through to
  // the model's own memory_recall cadence.
  const isOpeningTurn = history.every((m) => m.role !== 'assistant');
  interface PrimingBundle {
    samskaraAppendix: string;
    openingRecallBlock: string | null;
    /**
     * Today's automatic journal entry for the signed-in user, if one
     * exists. Injected as an appendix block on opening turns so the
     * model can weave continuity in without a tool call. Null when
     * there's no entry yet today, or when this isn't the opening
     * turn (mid-thread turns pay no tax).
     */
    journalEntry: JournalEntry | null;
  }
  // Pre-compute today's date in the user's timezone so the journal
  // lookup (a tiny indexed SELECT) can race alongside the samskara
  // bundle. Bucketing is cheap; both feeds run under the same
  // SAMSKARA_PRIMING_TIMEOUT_MS cap.
  const journalToday = todayInZone(journalTimezone ?? null);
  const primingWork = (async (): Promise<PrimingBundle> => {
    const [compoundSummary, fireResult, openingRecallBlock, journalRows] =
      await Promise.all([
        getCompoundSummary(supabase),
        fireSamskaras(supabase, venice, thread.id, currentUserRound, userText, signal),
        isOpeningTurn
          ? recallOpeningMemories(supabase, venice, userText, signal)
          : Promise.resolve<string | null>(null),
        // Only pull the journal row on the opening turn - the same
        // reason we only do opening-recall there. Mid-thread turns
        // would rebuild the same appendix every round with no benefit.
        // Degrades silently: an error here just means "no journal
        // block this turn."
        isOpeningTurn
          ? supabase.getJournalEntriesForDate(journalToday).catch(() => [])
          : Promise.resolve([]),
      ]);
    const automatic =
      journalRows.find((e) => e.source === 'automatic') ?? null;
    return {
      samskaraAppendix: formatPriming({
        compoundSummary,
        fire: fireResult as FireResult | null,
      }),
      openingRecallBlock,
      journalEntry: automatic,
    };
  })();
  const priming = await Promise.race<PrimingBundle>([
    primingWork,
    new Promise<PrimingBundle>((resolve) =>
      setTimeout(
        () =>
          resolve({
            samskaraAppendix: '',
            openingRecallBlock: null,
            journalEntry: null,
          }),
        SAMSKARA_PRIMING_TIMEOUT_MS
      )
    ),
  ]);
  // The title appendix note is the soft "rename if the topic shifted"
  // one-liner for threads that already carry a real title. It sits in
  // the system prompt as the lowest-priority block. The placeholder
  // case (loud "required this turn" directive) is handled separately
  // as a `role: 'system'` message appended after the user turn in the
  // round loop below - that position is closer to the generation point
  // than anything in the appendix can be. Null on placeholder + on
  // manually-named threads.
  const titleNote = buildTitleAppendixNote(thread);
  // Pre-compute the placeholder reminder once. It rides every round
  // until the chat loop returns - including rounds after the model
  // already called `update_title` - matching the same persist-across-
  // rounds behaviour the appendix-based directive had before.
  const titleReminder = buildTitleReminderMessage(thread);
  // Emphasis blurb slots between samskara priming and the title
  // note: ambient voice tuning, less urgent than the title nag.
  // Null when the setting is off so the filter below skips it cleanly.
  const emphasisNote = emphasisMarkdown ? buildEmphasisNote() : null;
  // Today's Journal block sits between the samskara priming and the
  // emphasis/title nudges: user-specific context (belongs with
  // samskara) but not urgent. Null on mid-thread turns or when no
  // automatic entry exists yet.
  const journalNote = buildJournalNote(priming.journalEntry);
  // User profile block: rendered first in the appendix so the model
  // sees who it's talking to before any of the ambient priming
  // blocks. Null when both fields are empty so a fresh account
  // pays zero tokens.
  const userProfileNote = buildUserProfileNote(userName, userLocation);

  // Per-turn thread-attachments block. Lists every file attached
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
  const threadAttachmentsBlock = buildThreadAttachmentsBlock(attachmentSummaries);

  const appendixParts = [
    userProfileNote,
    priming.samskaraAppendix,
    journalNote,
    threadAttachmentsBlock,
    emphasisNote,
    titleNote,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const promptAppendix = appendixParts.join('\n\n');

  // Push the opening-recall <think> block onto local history as an
  // ephemeral assistant turn. Not persisted - the round loop only
  // writes assistant rows that the model itself generated; this
  // synthetic turn lives only for the duration of this chat-loop
  // call, same contract as the <user_message> tag wrapping. Strict
  // role alternation is broken here (user -> assistant-think ->
  // assistant-reply), but Venice tolerates that on the wire and the
  // model reads the <think> block as its own prior recollection.
  if (priming.openingRecallBlock !== null) {
    history.push({
      role: 'assistant',
      content: priming.openingRecallBlock,
    });
  }

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
  let intuitionMessageIdx: number | null = null;
  let contextRecallCache: ContextRecallPayload | null =
    readContextRecallCache(thread);
  let contextRecallMessageIdx: number | null = null;

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
        ? withIntuitionInflight(thread.id, () =>
            runIntuitionPipeline({
              venice,
              model: intuitionModelId,
              history,
              signal,
              round: currentUserRound,
              mood: intuitionMood ?? null,
              trigger: intuitionPreTrigger,
            })
          )
        : Promise.resolve<IntuitionPayload | null>(null),
      contextRecallPreTrigger
        ? withContextRecallInflight(thread.id, () =>
            runContextRecallPipeline({
              venice,
              supabase,
              threadId: thread.id,
              userId,
              signal,
              round: currentUserRound,
              mood: intuitionMood ?? null,
              trigger: contextRecallPreTrigger,
            })
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

  // Inject synthetic <think> blocks. Order matters for how the model
  // reads its own priming chain: opening-recall (raw memory hits) was
  // already pushed above; context-recall (assimilated note - facts
  // not already in-thread plus calibration about what the user knows)
  // goes next; intuition (synthesised drive read on top of all of it)
  // goes last so the conscious response factors in the most-processed
  // layer most recently. A context-recall payload with empty `note`
  // resolves to null from buildContextRecallThinkMessage and is
  // skipped - we cache the negative result for debounce but don't
  // burn tokens on an empty <think> block.
  if (contextRecallCache) {
    const msg = buildContextRecallThinkMessage(contextRecallCache);
    if (msg !== null) {
      history.push(msg);
      contextRecallMessageIdx = history.length - 1;
    }
  }
  if (intuitionCache) {
    history.push(buildIntuitionThinkMessage(intuitionCache));
    intuitionMessageIdx = history.length - 1;
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Phase B abort exit: the prior round reached tool execution, then
    // the user clicked stop while tools were running. Promise.all
    // settled (each in-flight tool's childController fired; cancelled
    // tools landed as error rows via the tool executor's catch), so
    // the history is internally consistent. No content marker needed -
    // the error tool rows already tell the story. Flag the result so
    // the UI knows to suppress the inline error banner this failure
    // would otherwise raise.
    if (signal.aborted) {
      interrupted = true;
      break;
    }
    roundsRun++;

    // Prepend the baseline system prompt every round. It's not stored
    // in the DB — it's derived from the registry at request-time, so
    // adding a tool automatically updates what the model knows about,
    // and editing the identity copy takes effect for the next turn
    // with no migration. User-configured system prompts from Settings
    // ride AFTER this in `history`, which means a custom "you are a
    // pirate" prompt still wins on voice while the baseline tool
    // framing stays in force.
    //
    // The current user turn is ALWAYS wrapped in <user_message>
    // boundary tags (see tagLastUserMessage above). Venice's
    // `enable_web_scraping` is always on in venice.ts, so any URL the
    // user pastes lands inlined in the user turn alongside whatever
    // they typed. Wrapping unconditionally keeps the boundary
    // reliable; the ~10 tokens per user turn are a cheap price for a
    // signal the model can anchor on every time. Live web search,
    // previously also an `enable_web_search` injection on every
    // request, now flows through the `web_search` tool instead - the
    // main chat loop never sets those Venice parameters.
    //
    // The same projection also prepends a `<datetime>` tag (outside
    // the user_message fence) carrying current local + UTC time. The
    // model otherwise has no clock and either refuses or hallucinates
    // when asked "what time is it?". Recomputed every round so a
    // long multi-tool loop reflects actual elapsed time rather than
    // a stale send-time snapshot.
    //
    // The placeholder-title directive (when present) rides as a
    // `<system_reminder>` block APPENDED to the user turn, outside
    // the user_message fence. Earlier shapes - putting the directive
    // in the system-prompt appendix, then pushing it as a trailing
    // `role: 'system'` message - both let the model skip the rename
    // for many turns; the wire ends up dropping or de-weighting
    // trailing system rows on this provider, and a system-prompt
    // appendix gets buried above a long `history`. Riding inside the
    // user-role content is the position the model is guaranteed to
    // attend to.
    const datetimeTag = buildDatetimeTag(journalTimezone);
    const projectedHistory = tagLastUserMessage(history, datetimeTag, titleReminder);
    const requestMessages: VeniceMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          // Pass the thread's current gated-toolbox set so the
          // catalog block renders [x]/[ ] marks that match what the
          // model will actually see on the wire this round.
          enabledToolboxes: toolboxesEnabled,
          // Per-turn appendix - pre-computed before the round loop so
          // every round sees the same block. Carries low-urgency
          // ambient context (user profile, samskara priming, today's
          // journal, attachments, emphasis nudge, topic-drift title
          // hint). Empty string when none apply (cold-start manually-
          // named thread, priming timeout). The placeholder title
          // directive is NOT here - it rides inside the latest user
          // turn as a `<system_reminder>` block, outside the
          // user_message fence (see tagLastUserMessage above).
          promptAppendix: promptAppendix,
        }),
      },
      ...projectedHistory,
    ];

    // streamChatWithRateLimitRetry transparently retries on Venice 429s,
    // sleeping for the duration parsed from the response headers before
    // re-issuing. A non-retryable error or a final 429 propagates here
    // identically to a raw venice.streamChat call, so the abort and
    // generic-error branches below need no special-casing for retries.
    const stream = streamChatWithRateLimitRetry(
      venice,
      {
        model: modelId,
        messages: requestMessages,
        signal,
        tools: buildToolList(toolboxesEnabled),
        reasoningEffort,
        disableThinking,
        verbosity,
      },
      handlers
    );

    let roundText = '';
    let roundReasoning = '';
    let roundCitations: Citation[] | null = null;
    const roundCalls: OpenAIToolCall[] = [];
    let roundUsage: TokenUsage | null = null;
    try {
      for await (const ev of stream) {
        if (ev.type === 'text') {
          roundText += ev.delta;
          handlers?.onTextUpdate?.(roundText);
        } else if (ev.type === 'reasoning') {
          roundReasoning += ev.delta;
          handlers?.onReasoningUpdate?.(roundReasoning);
        } else if (ev.type === 'tool_call') {
          roundCalls.push(ev.toolCall);
        } else if (ev.type === 'usage') {
          // Captured from the stream's trailing usage frame. Persisted on
          // every assistant row we write below — the tokens were spent
          // regardless of whether the turn produced text or tool calls,
          // and we want the per-row data honest for future aggregates.
          roundUsage = ev.usage;
        } else if (ev.type === 'citations') {
          roundCitations = ev.citations;
        }
      }
    } catch (err) {
      // User clicked the stop button (or the caller aborted for any
      // other reason) while the stream was still producing deltas.
      // `fetch` rejects with an AbortError whose `.name` is literally
      // 'AbortError'; we also check `signal.aborted` as a belt-and-
      // braces fallback because a `reader.read()` rejection shape
      // isn't fully standardized across browsers and some runtimes
      // wrap the error.
      //
      // Persist whatever text / reasoning / citations arrived this
      // round with a visible marker appended to the content field so
      // the user can see exactly where the reply was cut. Partial
      // tool-call fragments live inside venice.ts's private accumulator
      // and are never emitted as tool_call events mid-stream, so there
      // is nothing partial to drop here - any entries in roundCalls
      // are fully-assembled-but-unexecuted, and we discard them per
      // spec (the user asked to stop; an unexecuted tool call isn't
      // "a tool call completed already"). Break out of the round loop
      // without recursing into tool execution.
      const isAbort =
        signal.aborted ||
        (err instanceof Error && err.name === 'AbortError');
      if (!isAbort) throw err;
      interrupted = true;
      if (roundText.length > 0 || roundReasoning.length > 0) {
        // Same citation priority as the clean-finish branch below:
        // outer-stream citations win over accumulated tool citations.
        const finalCitations =
          roundCitations ?? (toolCitations.length > 0 ? toolCitations : null);
        // Append the marker on its own line after whatever prose
        // arrived. An empty roundText with reasoning-only still gets
        // the marker as standalone content so the bubble renders
        // something - otherwise the user sees only the reasoning
        // panel with no indication the answer was cut.
        const interruptedContent =
          roundText.length > 0
            ? `${roundText}\n\n${INTERRUPTED_MARKER}`
            : INTERRUPTED_MARKER;
        const commitOpts = {
          model: modelId,
          // Usage frame often doesn't land before the abort - Venice
          // emits it after the last choice-bearing frame. The column
          // is nullable; the context ring simply hides on absence.
          usage: roundUsage,
          reasoning: roundReasoning.length > 0 ? roundReasoning : null,
          citations: finalCitations,
        };
        // Use the atomic commit path when we have a user message anchor so
        // a conflicting send from another device blocks the insert. Fall
        // back to addMessage for older callers / tests that don't supply it.
        if (userMessageId) {
          const result = await supabase.commitAssistantMessage(
            thread.id, interruptedContent, commitOpts, userMessageId
          );
          if (result.conflict) {
            conflictDetected = true;
          } else {
            handlers?.onAssistantPersisted?.(result.message);
            lastAssistantId = result.message.id;
          }
        } else {
          const msg = await supabase.addMessage(
            thread.id, 'assistant', interruptedContent, commitOpts
          );
          handlers?.onAssistantPersisted?.(msg);
          lastAssistantId = msg.id;
        }
      }
      finalText = roundText;
      break;
    }

    // No tool calls → this is the final assistant message. Persist and
    // exit; no need for a tool round.
    if (roundCalls.length === 0) {
      // Persist when there is text, reasoning, or both. A response with
      // only reasoning_content (content === "") is valid - kimi-k2 and
      // some other models emit reasoning-only turns - and must be saved
      // so the streaming bubble isn't orphaned when the stream closes.
      if (roundText.length > 0 || roundReasoning.length > 0) {
        // Citations priority:
        //   1. `roundCitations` from the outer stream - only non-null
        //      when the main chat request itself asked Venice for
        //      server-side search, which nak no longer does. Kept as
        //      the first branch for defensive parity with the old
        //      shape and so a future re-enablement of main-chat search
        //      would Just Work without revisiting this line.
        //   2. Accumulated tool citations from any `web_search` calls
        //      that ran in the turn. This is the live path.
        //   3. null - no citations to render.
        const finalCitations =
          roundCitations ?? (toolCitations.length > 0 ? toolCitations : null);
        const commitOpts = {
          model: modelId,
          usage: roundUsage,
          // Reasoning / citations ride along on the assistant row so
          // the panels below the message survive a page refresh. Null
          // when the model didn't produce either — keeps older rows
          // (before the columns existed) distinguishable from "this
          // turn actually had none."
          reasoning: roundReasoning.length > 0 ? roundReasoning : null,
          citations: finalCitations,
        };
        // Use the atomic commit path when we have a user message anchor so
        // a conflicting send from another device blocks the insert. Fall
        // back to addMessage for older callers / tests that don't supply it.
        if (userMessageId) {
          const result = await supabase.commitAssistantMessage(
            thread.id, roundText, commitOpts, userMessageId
          );
          if (result.conflict) {
            conflictDetected = true;
          } else {
            handlers?.onAssistantPersisted?.(result.message);
            lastAssistantId = result.message.id;
          }
        } else {
          const msg = await supabase.addMessage(thread.id, 'assistant', roundText, commitOpts);
          handlers?.onAssistantPersisted?.(msg);
          lastAssistantId = msg.id;
        }
      }
      finalText = roundText;
      break;
    }

    // Persist the assistant row first so the tool rows below have
    // something to pair to in future replays. `content` can be empty
    // on a pure tool-call response — OpenAI sends content=null then,
    // but our column is NOT NULL so we coerce to ''.
    const assistantMsg = await supabase.addMessage(
      thread.id,
      'assistant',
      roundText,
      {
        tool_calls: roundCalls,
        model: modelId,
        usage: roundUsage,
        // Intermediate tool-invoking rounds rarely carry reasoning or
        // citations — but when they do (some reasoning models think
        // out loud before picking a tool), persist them so the
        // per-round panels reflect what actually happened.
        reasoning: roundReasoning.length > 0 ? roundReasoning : null,
        citations: roundCitations,
      }
    );
    handlers?.onAssistantPersisted?.(assistantMsg);
    lastAssistantId = assistantMsg.id;

    // Kick every tool off in parallel so the wall-clock latency is
    // max(individual durations) rather than sum. Each promise catches
    // internally so Promise.all never rejects — we want all of them to
    // settle before moving on, mirroring OpenAI's requirement that
    // every tool_call has a matching tool-result row.
    const executions = roundCalls.map(async (call) => {
      handlers?.onToolStart?.(call);
      const ctl = childController(signal);
      const ctx: ToolContext = {
        supabase,
        venice,
        userId,
        threadId: thread.id,
        signal: ctl.signal,
        // Main chat is the root of the agent-recursion tree; tools
        // dispatched here run at depth 0. A tool that spawns an
        // agent passes this through so `runHeadlessToolLoop` can
        // compute the bumped depth and apply the MAX_AGENT_DEPTH cap.
        depth: 0,
      };
      let args: Record<string, unknown>;
      try {
        // Arguments arrive as a JSON string per the OpenAI spec. An
        // invalid JSON blob is the model's fault, not ours - surface
        // it as a tool error so the next round sees the parse failure.
        // parseToolArguments also recovers from a known LLM
        // double-escape bug on multi-line free-form fields (memory
        // data, recipe instructions); see ./tools/wire.ts.
        args = parseToolArguments(call.function.arguments);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        handlers?.onToolError?.(call, error);
        return { call, ok: false as const, error };
      }
      try {
        const value = await executeToolCall(call.function.name, args, ctx);
        handlers?.onToolDone?.(call, value);
        // `toggle_toolbox` is the only tool that changes the gated-
        // toolbox set; observe its return value instead of a separate
        // DB re-fetch. The tool's execute handler already filtered the
        // incoming names against the known toolbox list, so whatever
        // we read back here is a valid array.
        if (call.function.name === toggleToolbox.name) {
          const raw = (value as { enabled?: unknown })?.enabled;
          const next = Array.isArray(raw)
            ? raw.filter((v): v is string => typeof v === 'string')
            : [];
          if (!sameToolboxSet(next, toolboxesEnabled)) {
            toolboxesEnabled = next;
            handlers?.onToolboxesEnabledChange?.(toolboxesEnabled);
          }
        }
        // update_title returns the sanitised title; forward so the UI
        // can patch the drawer row immediately rather than waiting for
        // the end-of-turn refreshThreads() to pick up the change.
        if (call.function.name === updateTitle.name) {
          const newTitle = (value as { title?: string })?.title;
          if (typeof newTitle === 'string' && newTitle.length > 0) {
            handlers?.onTitleChange?.(newTitle);
          }
        }
        return { call, ok: true as const, value };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        handlers?.onToolError?.(call, error);
        return { call, ok: false as const, error };
      }
    });
    const settled = await Promise.all(executions);

    // Extend the history with the assistant-with-tool-calls row plus
    // one tool-result row per call. Order matters: the assistant row
    // must precede its result rows in the array we send next round.
    // Arguments are sanitised before going back on the wire - see
    // sanitizeToolCallsForWire for the rationale (Venice 400s on a
    // malformed arguments JSON string and the failure rides every
    // subsequent round unless we normalise here).
    history.push({
      role: 'assistant',
      content: roundText,
      tool_calls: sanitizeToolCallsForWire(roundCalls),
    });
    for (const r of settled) {
      const content = r.ok
        ? encodeToolContent({ ok: true, value: r.value })
        : encodeToolContent({ ok: false, error: r.error });
      const msg = await supabase.addMessage(thread.id, 'tool', content, {
        tool_call_id: r.call.id,
        name: r.call.function.name,
      });
      handlers?.onToolResultPersisted?.(msg);
      // Pair the in-loop tool result with its assistant call by id.
      // The assistant row's tool_calls just above were rewritten through
      // sanitizeToolCallsForWire, which mutates the id when it doesn't
      // satisfy Venice's strict tool_call_id pattern; mirror that here
      // so the next streamChat round sees a matching pair instead of
      // an orphan result row.
      history.push({
        role: 'tool',
        content,
        tool_call_id: sanitizeToolCallIdForWire(r.call.id),
        name: r.call.function.name,
      });
      // Harvest citations from any tool that returned them (web_search
      // is the intended source; the shape check is structural, not
      // name-based, so a future tool returning `{..., citations: [...]}`
      // rides the same path without another branch here). Indexes are
      // rewritten to the running 1-based global position so the
      // rendered CitationsPanel sees a contiguous list regardless of
      // per-tool numbering.
      if (r.ok) {
        const extracted = extractToolCitations(r.value);
        for (const cite of extracted) {
          toolCitations.push({ ...cite, index: toolCitations.length + 1 });
        }
      }
    }

    // Mid-turn title trigger: if any update_title call succeeded this
    // round, the topic has meaningfully shifted - re-fire whichever
    // subconscious-priming pipelines are enabled, in parallel, so the
    // model's next streamChat round sees fresh subconscious priming
    // computed against the post-rename topic. Each pipeline's same-
    // round debounce prevents a duplicate fire when the pre-round
    // trigger already covered this user-round (rare, but possible if
    // the model called update_title twice in one turn).
    //
    // The replace-on-refresh discipline matters: the previous synthetic
    // <think> block was computed against the pre-rename perception and
    // is now obsolete. Replacing the slot keeps the model from seeing
    // two competing <think> blocks for the same surface.
    const titleSucceeded = settled.some(
      (r) => r.ok && r.call.function.name === updateTitle.name
    );
    if (titleSucceeded && (intuitionModelId || contextRecallEnabled)) {
      const intuitionTitleTrigger =
        intuitionModelId !== undefined
          ? evaluateTitleTrigger({
              cache: intuitionCache,
              round: currentUserRound,
              mood: intuitionMood ?? null,
            })
          : null;
      const contextRecallTitleTrigger = contextRecallEnabled
        ? evaluateTitleTrigger({
            cache: contextRecallCache,
            round: currentUserRound,
            mood: intuitionMood ?? null,
          })
        : null;

      if (intuitionTitleTrigger || contextRecallTitleTrigger) {
        const [freshIntuition, freshContextRecall] = await Promise.all([
          intuitionTitleTrigger && intuitionModelId
            ? withIntuitionInflight(thread.id, () =>
                runIntuitionPipeline({
                  venice,
                  model: intuitionModelId,
                  history,
                  signal,
                  round: currentUserRound,
                  mood: intuitionMood ?? null,
                  trigger: intuitionTitleTrigger,
                })
              )
            : Promise.resolve<IntuitionPayload | null>(null),
          contextRecallTitleTrigger
            ? withContextRecallInflight(thread.id, () =>
                runContextRecallPipeline({
                  venice,
                  supabase,
                  threadId: thread.id,
                  userId,
                  signal,
                  round: currentUserRound,
                  mood: intuitionMood ?? null,
                  trigger: contextRecallTitleTrigger,
                })
              )
            : Promise.resolve<ContextRecallPayload | null>(null),
        ]);

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

        if (freshIntuition) handlers?.onIntuitionUpdate?.(freshIntuition);
        if (freshContextRecall)
          handlers?.onContextRecallUpdate?.(freshContextRecall);

        // Replace-on-refresh for the synthetic <think> blocks. Each
        // surface owns its own slot; if the slot was empty before
        // (the pre-round trigger short-circuited), append instead.
        if (freshIntuition) {
          const refreshedMsg = buildIntuitionThinkMessage(freshIntuition);
          if (intuitionMessageIdx !== null) {
            history[intuitionMessageIdx] = refreshedMsg;
          } else {
            history.push(refreshedMsg);
            intuitionMessageIdx = history.length - 1;
          }
        }
        if (freshContextRecall) {
          const refreshedMsg = buildContextRecallThinkMessage(
            freshContextRecall
          );
          if (refreshedMsg !== null) {
            if (contextRecallMessageIdx !== null) {
              history[contextRecallMessageIdx] = refreshedMsg;
            } else {
              history.push(refreshedMsg);
              contextRecallMessageIdx = history.length - 1;
            }
          } else if (contextRecallMessageIdx !== null) {
            // Refreshed payload has an empty note. Replace the
            // previous block with a still-non-empty marker turn
            // would re-inject a stale recollection; instead we
            // overwrite with an empty `<think></think>` placeholder
            // so the slot index stays valid for any subsequent
            // refresh. Empty-tag content is a no-op on the wire.
            history[contextRecallMessageIdx] = {
              role: 'assistant',
              content: '<think></think>',
            };
          }
        }
      }
    }

    // Loop back for another round. The model will see the tool results
    // in the extended history and either produce a final answer or
    // request more tool calls.
    if (round === MAX_ROUNDS - 1) {
      stoppedByLimit = true;
    }
  }

  // Samskara substrate stub. Written once per turn after the loop
  // settles, paired with whichever assistant row closed the turn.
  // Fire-and-forget: a substrate write failure is logged inside
  // `recordSubstrateStub` but not surfaced — the formation pipeline
  // simply has fewer rows to work from until the next round writes
  // successfully. Skipped when the caller didn't supply
  // userMessageId (older callers, tests) or when no assistant row
  // landed at all (early abort, error path).
  if (userMessageId && lastAssistantId !== null) {
    void recordSubstrateStub(supabase, thread.id, userMessageId, lastAssistantId);
  }

  return { finalText, roundsRun, stoppedByLimit, interrupted, conflictDetected, toolboxesEnabled };
}
