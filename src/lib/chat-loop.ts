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
import {
  combineVerdicts,
  GuardExhaustedError,
  MAX_STREAM_GUARD_RETRIES,
  streamGuardsFor,
  type AttemptProgress,
  type StreamGuard,
} from './stream-guards';
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
  askUser,
  ASK_USER_PENDING_FLAG,
  buildAskUserAnswerContent,
  type AskUserOption,
} from './tools/ask_user';
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
  const utc = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
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
 *   4. Emphasis-markdown formatting nudge, when the toggle is on.
 *   5. Title nudge, from round 2 onward: the loud placeholder nag
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
 * messages and the conversation that follows. Used by the chat-loop
 * to insert the per-turn metadata system message between the two -
 * baseline system prompt first, then the user's enabled system
 * prompts (voice / persona tuning), then the metadata block (ambient
 * context the model should read just before the user turn), then
 * the actual conversation.
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

/**
 * Wrap {@link streamChatWithRateLimitRetry} in a generic output-guard
 * retry loop. A guard inspects each streaming attempt and can reject it
 * ("this completion is junk, re-roll") before any of its events reach
 * the consumer - so a discarded attempt never corrupts the round's
 * accumulated text. The first consumer is the special-token-leak guard
 * (see stream-guards.ts); the mechanism itself is guard-agnostic so
 * future model/provider gotchas plug in without touching this loop.
 *
 * How the buffering works: events from an attempt are held in a buffer
 * until the guards collectively 'keep' the attempt, at which point the
 * buffer is flushed and the rest of the stream passes through live. If
 * the guards 'retry' instead, the buffered events are dropped, this
 * attempt's stream is torn down (its child AbortController fires), and
 * the request is re-issued with whatever mutation the guard applied
 * (the leak guard bumps temperature so the re-roll samples
 * differently). The buffer window is short in the healthy case - the
 * first reasoning delta, tool call, or few characters of non-leak text
 * commits the attempt - so live streaming is preserved for real
 * replies.
 *
 * Nesting: this wraps the rate-limit retry, so each guard attempt gets
 * the full 429 handling. A re-roll re-enters with a fresh rate-limit
 * budget, which is correct - it's a brand-new request.
 *
 * Cap: MAX_STREAM_GUARD_RETRIES re-rolls, then a GuardExhaustedError
 * propagates for the UI to surface with a manual-retry affordance.
 *
 * Fires `handlers.onGuardRetry` once per re-roll, before the next
 * attempt starts, so the UI can mark the discarded attempt (the "oops,
 * all slop!" notice card) and reset its streaming buffers.
 *
 * With no armed guards the wrapper is a transparent pass-through - no
 * buffering, no behavioral change for models without configured
 * gotchas.
 */
async function* streamChatWithGuards(
  venice: VeniceClient,
  req: ChatRequest,
  handlers: ChatLoopHandlers | undefined,
  guards: StreamGuard[],
): AsyncGenerator<StreamEvent, void, void> {
  const outerSignal = req.signal;
  if (!outerSignal) {
    throw new Error('streamChatWithGuards requires req.signal');
  }
  if (guards.length === 0) {
    yield* streamChatWithRateLimitRetry(venice, req, handlers);
    return;
  }

  let attemptReq = req;
  let attempt = 0;
  for (;;) {
    // Scope each attempt to a child controller so a guard rejecting it
    // can tear down that attempt's in-flight fetch immediately - we
    // stop paying for a leak that's still streaming - without aborting
    // the user's whole turn (the outer signal).
    const child = childController(outerSignal);
    const progress: AttemptProgress = {
      visibleText: '',
      sawReasoning: false,
      sawToolCall: false,
      ended: false,
    };
    const buffer: StreamEvent[] = [];
    let committed = false;
    let retryGuard: string | null = null;
    try {
      for await (const ev of streamChatWithRateLimitRetry(
        venice,
        { ...attemptReq, signal: child.signal },
        handlers,
      )) {
        if (committed) {
          yield ev;
          continue;
        }
        buffer.push(ev);
        if (ev.type === 'text') progress.visibleText += ev.delta;
        else if (ev.type === 'reasoning') progress.sawReasoning = true;
        else if (ev.type === 'tool_call') progress.sawToolCall = true;
        const verdicts = guards.map((g) => g.verdict(progress));
        const combined = combineVerdicts(verdicts);
        if (combined === 'retry') {
          retryGuard = guards[verdicts.indexOf('retry')].name;
          break;
        }
        if (combined === 'keep') {
          committed = true;
          for (const b of buffer) yield b;
          buffer.length = 0;
        }
      }
    } finally {
      // No-op when the attempt already finished cleanly; decisive when
      // we broke out early on a retry. Breaking the for-await above also
      // runs the inner generator's return() (releasing its reader), so
      // this just severs the underlying fetch.
      child.abort();
    }

    if (committed) return;

    if (retryGuard === null) {
      // Stream ended while still buffering (every guard was undecided).
      // Resolve with `ended` set so a guard can give a final verdict on
      // a short-but-legitimate reply.
      progress.ended = true;
      const verdicts = guards.map((g) => g.verdict(progress));
      if (combineVerdicts(verdicts) !== 'retry') {
        for (const b of buffer) yield b;
        return;
      }
      retryGuard = guards[verdicts.indexOf('retry')].name;
    }

    if (attempt >= MAX_STREAM_GUARD_RETRIES) {
      throw new GuardExhaustedError(retryGuard, attempt + 1);
    }
    attempt += 1;
    handlers?.onGuardRetry?.({ guard: retryGuard, attempt });
    attemptReq = guards.reduce((r, g) => g.prepareRetry(r, attempt), attemptReq);
  }
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
    displayTimezone,
    lastAssistantTimestamp,
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
        fireSamskaras(supabase, venice, thread.id, currentUserRound, userText, signal)
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
        ? trackSubconscious(
            'intuition',
            withIntuitionInflight(thread.id, () =>
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
          )
        : Promise.resolve<IntuitionPayload | null>(null),
      contextRecallPreTrigger
        ? trackSubconscious(
            'recall',
            withContextRecallInflight(thread.id, () =>
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
  //      5 drives + synthesis), reads cleanly when it lands last.
  //
  // Each push is conditional: an empty-note context-recall, a
  // cold-start thread with no compound summary, a turn where the fire
  // top-k came back empty, an intuition-disabled thread - any of those
  // skips its push so we never burn tokens on an empty `<think>` block.
  if (contextRecallCache) {
    const msg = buildContextRecallThinkMessage(contextRecallCache);
    if (msg !== null) {
      history.push(msg);
      contextRecallMessageIdx = history.length - 1;
    }
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
    intuitionMessageIdx = history.length - 1;
  }

  // Output guards for this turn's model. Constant across rounds, so
  // resolve once. A model with no configured gotchas gets an empty
  // guard list and the wrapper is a pass-through. The guard detects
  // junk completions (e.g. a leaked special token) client-side and
  // re-rolls - there's no server-side stop, deliberately, so a reply
  // that legitimately mentions one of these sequences mid-stream isn't
  // truncated.
  const streamGuards = streamGuardsFor(modelId);

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

    // Three-layer system-prompt assembly. The baseline prompt
    // (identity, voice, recall framing, toolbox catalog) leads;
    // user-configured system prompts from Settings ride next so a
    // custom "you are a pirate" prompt still wins on voice while the
    // baseline tool framing stays in force; the per-turn metadata
    // system message comes last among the system rows so the model
    // reads ambient context (datetime, attachments inventory, title
    // and emphasis nudges) immediately before the user turn. The
    // user message itself rides bare - no `<user_message>` fence,
    // no `<datetime>` tag, no `<system_reminder>` directive folded
    // in. The role:user / role:system boundary is the structural
    // signal now; the in-content tags were a workaround for the
    // URL-scraping auto-injection that's no longer in play.
    //
    // The metadata message is rebuilt every round so wall-clock,
    // since-last-reply, and live title state stay current across
    // multi-tool turns that span tens of seconds. The split between
    // baseline + user-system + metadata + conversation lets a
    // single Venice request pass them through with no extra
    // pre/post-processing.
    const { userSystem, conversation } = splitSystemPreamble(history);
    const metadataMessage = buildMetadataSystemMessage({
      userName,
      userLocation,
      displayTimezone,
      lastAssistantTimestamp,
      attachmentSummaries,
      emphasisMarkdown,
      threadTitle: thread.title,
      titleManuallySet: thread.title_manually_set,
      currentUserRound,
    });
    const requestMessages: VeniceMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          // Pass the thread's current gated-toolbox set so the
          // catalog block renders [x]/[ ] marks that match what the
          // model will actually see on the wire this round.
          enabledToolboxes: toolboxesEnabled,
          // Pre-rendered bias-profile block read once at turn entry
          // (see `biasProfileBlock` above); reused across every
          // round of this turn since it doesn't change inside a
          // single user-message exchange.
          biasProfile: biasProfileBlock,
        }),
      },
      ...userSystem,
      metadataMessage,
      ...conversation,
    ];

    // streamChatWithRateLimitRetry transparently retries on Venice 429s,
    // sleeping for the duration parsed from the response headers before
    // re-issuing. A non-retryable error or a final 429 propagates here
    // identically to a raw venice.streamChat call, so the abort and
    // generic-error branches below need no special-casing for retries.
    const stream = streamChatWithGuards(
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
      handlers,
      streamGuards,
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
        // Recall hygiene for wiki_search drill-downs from the main
        // chat: drop articles whose only source is this thread. The
        // autonomous wiki agent and the librarian leave this off so
        // they can find articles to update; the main model surfacing
        // its own thread's synthesis as recall would be circular.
        wikiExcludeOwnThreadSoleSources: true,
        // Same hygiene for conversation_search: when the main chat
        // reaches for prior conversations as a drill-down, surface
        // OTHER threads. The current thread's content is already in
        // the working context.
        conversationExcludeOwnThread: true,
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

    // Identify the FIRST successful ask_user call in this round. Per
    // the multi-call rule (see docs/dev/chat.md), only the first
    // ask_user suspends the loop; any sibling ask_user calls land as
    // pre-cancelled answer rows so the wire shape stays valid but the
    // UI doesn't render a second pending card. The discriminator is
    // call.id rather than call object identity so the rewrite below
    // can compare against settled[].call.id without aliasing
    // concerns.
    let firstAskUserCallId: string | null = null;
    let firstAskUserQuestion = '';
    let firstAskUserOptions: AskUserOption[] = [];
    for (const r of settled) {
      if (!r.ok) continue;
      if (r.call.function.name !== askUser.name) continue;
      // The tool's execute() returns the pending sentinel shape;
      // sniff for the magic flag to confirm we are looking at a
      // legitimate suspend-bearing result rather than an error-
      // shaped object that happens to be ok=true.
      const v = r.value as Record<string, unknown> | null | undefined;
      if (!v || v[ASK_USER_PENDING_FLAG] !== true) continue;
      firstAskUserCallId = r.call.id;
      firstAskUserQuestion = typeof v.question === 'string' ? v.question : '';
      const rawOptions = Array.isArray(v.options) ? v.options : [];
      firstAskUserOptions = rawOptions
        .filter((o): o is { label: string; description: string } =>
          !!o &&
          typeof o === 'object' &&
          typeof (o as { label?: unknown }).label === 'string' &&
          typeof (o as { description?: unknown }).description === 'string'
        )
        .map((o) => ({ label: o.label, description: o.description }));
      break;
    }

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
      // Sibling-cancel path: if the model issued ask_user alongside
      // another ask_user call in the same round, the second (and
      // beyond) lands as a pre-cancelled answer row so the UI never
      // shows a second pending card and the resumed turn sees the
      // cancellation explicitly. The first ask_user falls through to
      // the normal encodeToolContent path - its pending sentinel
      // ships verbatim and the loop suspends below.
      let content: string;
      if (
        firstAskUserCallId !== null &&
        r.call.function.name === askUser.name &&
        r.call.id !== firstAskUserCallId
      ) {
        content = buildAskUserAnswerContent(
          null,
          'cancelled_by_sibling_ask_user'
        );
      } else {
        content = r.ok
          ? encodeToolContent({ ok: true, value: r.value })
          : encodeToolContent({ ok: false, error: r.error });
      }
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

    // Suspend the loop if ask_user landed this round. The pending
    // tool row is already persisted (the encodeToolContent path above
    // emits the sentinel verbatim), siblings are either real results
    // or pre-cancelled markers, and the wire shape is internally
    // consistent. The substrate stub is intentionally skipped at the
    // bottom of this function when awaitingUserAnswer is set - the
    // turn is not logically complete yet. The mid-turn title-trigger
    // pipeline below is also skipped via this early break, which is
    // the desired behaviour: a pending question is the next "user
    // input" the topic-shift signal would react to, and re-firing
    // intuition now would burn compute on a stale view.
    if (firstAskUserCallId !== null) {
      awaitingUserAnswer = {
        toolCallId: firstAskUserCallId,
        question: firstAskUserQuestion,
        options: firstAskUserOptions,
      };
      break;
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
            ? trackSubconscious(
                'intuition',
                withIntuitionInflight(thread.id, () =>
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
              )
            : Promise.resolve<IntuitionPayload | null>(null),
          contextRecallTitleTrigger
            ? trackSubconscious(
                'recall',
                withContextRecallInflight(thread.id, () =>
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

// Test hook: the formatter is otherwise integration-tested via the
// `<datetime>` tag's since_last_response attribute, but the bucket
// thresholds (just-now / few-minutes / hour / day / week / month /
// year boundaries) are easier to verify directly than via a
// runChatLoop fixture per bucket.
export const __test = {
  formatRelativeDuration,
  // The output-guard wrapper is otherwise only reachable through a full
  // runChatLoop fixture; exposing it lets the buffering / retry / cap
  // edge cases be driven directly with a fake stream and fake guards.
  streamChatWithGuards,
};
