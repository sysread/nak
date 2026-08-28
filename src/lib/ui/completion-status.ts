/**
 * CompletionStatus - the single source of truth for "how did the last
 * completion turn out, and what should the user see about it".
 *
 * Every "the turn did not finish / something went wrong" surface on
 * the chat screen is derived here: the transcript-tail heuristics,
 * the recovery-banner arbitration, and the persistent/live error
 * copy. The module makes ONE holistic decision from all available
 * signals and returns at most one descriptor; Chat.svelte renders it
 * with CompletionStatusCard.
 *
 * Layers:
 *
 *   1. classifyTail - reads the persisted transcript tail (including
 *      the synthetic recovery rows the wire-shape synthesizer adds on
 *      read) and returns a typed verdict about the completion.
 *   2. copyForErrorKind - the kind-to-copy table. Live (in-session)
 *      and persisted (threads.last_error) errors both become this
 *      shape, so the same failure renders the same card in-session
 *      and after a reload.
 *   3. selectCompletionStatus - the arbiter. Takes the tail verdict
 *      plus every competing signal (live error, persisted error,
 *      orphaned IndexedDB draft, activity gates) and returns at most
 *      ONE descriptor. Exactly one "what went wrong" card is ever on
 *      screen, and it carries the most actionable message.
 *
 * Retry semantics live in the verdict, not in the handler: the card
 * carries a RetryIntent (continue from the anchor user message, or
 * replace a dead tail row) and the screen binds ONE dispatcher to
 * it. This replaces the former two-handler split whose REPLACE vs
 * CONTINUE decisions agreed only by coincidence.
 *
 * Interacts with: src/screens/Chat.svelte (the status derivation +
 * retry dispatcher + card render), src/lib/exchange/exchange-slot.svelte.ts
 * (the StreamingError envelope this module's LiveError shape backs),
 * src/lib/conversation-recovery.ts (the healed-tail marker check),
 * src/lib/ask-user.ts (the pending-sentinel suppression).
 */

import type { Message } from '$lib/supabase';
import {
  parseAskUserContent,
  ASK_USER_PENDING_FLAG,
} from '$lib/ask-user';
import { isRecoveryMessage } from '$lib/conversation-recovery';

/**
 * Error kinds shared by the live (in-session catch sites) and
 * persisted (threads.last_error) error paths. Mirrors the
 * function-side TranslatedErrorKind in
 * supabase/functions/_shared/error-translate.ts - the union stays in
 * sync by virtue of being read off the same column / event stream.
 */
export type CompletionErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'http'
  | 'network'
  | 'parse'
  | 'truncated'
  | 'internal'
  | 'round_limit'
  | 'wall_timeout'
  | 'tool_dispatch'
  | 'commit_conflict'
  | 'guard_exhausted';

const KNOWN_KINDS: ReadonlyArray<CompletionErrorKind> = [
  'auth',
  'rate_limit',
  'http',
  'network',
  'parse',
  'truncated',
  'internal',
  'round_limit',
  'wall_timeout',
  'tool_dispatch',
  'commit_conflict',
  'guard_exhausted',
];

function isKnownKind(value: unknown): value is CompletionErrorKind {
  return (
    typeof value === 'string' &&
    KNOWN_KINDS.includes(value as CompletionErrorKind)
  );
}

export interface ParsedLastError {
  kind: CompletionErrorKind;
  message: string;
  retryable: boolean;
  /** ISO timestamp the function wrote when the error landed. */
  occurredAt: string | null;
}

/**
 * Parse the threads.last_error jsonb into an envelope, or null when
 * the value doesn't carry an interpretable error envelope. Absent
 * fields read through defaults so a partially-written column still
 * renders; an unrecognizable shape reads as null (no card) rather
 * than crashing the derivation.
 */
export function parseLastError(value: unknown): ParsedLastError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!isKnownKind(obj.kind)) return null;
  const message =
    typeof obj.message === 'string' && obj.message.length > 0
      ? obj.message
      : '';
  // Default retryable=true for unknown shapes - a missing flag should
  // err on the side of letting the user try again. The writer always
  // sets it for known kinds, so the default only kicks in for shapes
  // outside the current schema.
  const retryable = obj.retryable !== false;
  const occurredAt =
    typeof obj.occurred_at === 'string' && obj.occurred_at.length > 0
      ? obj.occurred_at
      : null;
  return { kind: obj.kind, message, retryable, occurredAt };
}

/**
 * A live in-session error, set by the exchange catch sites. The kind
 * drives the card's title and advice from the same table the
 * persisted path uses; `detail` carries any provider-specific raw
 * text (unwrapped rate-limit reason, raw thrown message) for the
 * collapsed detail section; `retry` is the site's context-specific
 * retry closure when re-firing is meaningful.
 */
export interface LiveError {
  kind: CompletionErrorKind;
  detail?: string;
  retry?: () => void;
}

/**
 * Render an unknown thrown value as a non-empty human string. The
 * naive `err.message` fallback broke on the "reasoning streams then
 * vanishes silently" bug: an Error with an empty `.message` (or a
 * non-Error thrown value) left the banner with empty text, which the
 * user read as "no error at all". Cascade down to `name`, then a
 * JSON dump, then the literal `String(err)`, so something always
 * lands. Never returns an empty string.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message?.trim();
    if (msg) return msg;
    if (err.name) return err.name;
    return 'Error';
  }
  if (typeof err === 'string') return err || 'Unknown error';
  if (err && typeof err === 'object') {
    try {
      const s = JSON.stringify(err);
      if (s && s !== '{}') return s;
    } catch {
      // fall through
    }
  }
  const s = String(err ?? '');
  return s || 'Unknown error';
}

/**
 * Unwrap a Venice rate-limit error into detail text for the card.
 * The raw err.message is `Venice rate limit hit (HTTP 429). <detail>`
 * where <detail> is usually the OpenAI-compat envelope
 * `{"error":"The model is currently overloaded..."}`. Peel both
 * layers so the user sees only the provider's reason; fall back to
 * the raw message when parsing fails.
 */
export function formatRateLimitMessage(err: {
  message: string;
  status?: number | null;
}): string {
  const prefix = `Venice rate limit hit (HTTP ${err.status ?? 429}). `;
  const detail = err.message.startsWith(prefix)
    ? err.message.slice(prefix.length).trim()
    : err.message.trim();
  if (detail.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (parsed && typeof parsed === 'object') {
        const e = (parsed as { error?: unknown }).error;
        if (typeof e === 'string') return e;
        if (
          e &&
          typeof e === 'object' &&
          typeof (e as { message?: unknown }).message === 'string'
        ) {
          return (e as { message: string }).message;
        }
      }
    } catch {
      // Not JSON - fall through to the raw detail.
    }
  }
  return detail || 'Rate limited. Please try again later.';
}

/**
 * The title + advice pair for an error kind - the card's copy in one
 * call. Composed from the two tables above so the arbiter and the
 * tests share one entry point.
 */
export function copyForErrorKind(kind: CompletionErrorKind): {
  title: string;
  advice: string;
} {
  return { title: titleFor(kind), advice: adviceFor(kind) };
}

/**
 * Low-detail card titles per error kind. Terse on purpose - the
 * advice line carries the guidance; the title only has to answer
 * "what kind of problem".
 */
export function titleFor(kind: CompletionErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'API key rejected';
    case 'rate_limit':
      return 'Rate limited';
    case 'http':
      return 'Request failed';
    case 'network':
      return 'Network error';
    case 'parse':
      return "Couldn't read the response";
    case 'truncated':
      return 'Response cut off';
    case 'internal':
      return 'Something went wrong';
    case 'round_limit':
      return 'Hit the round limit';
    case 'wall_timeout':
      return 'Timed out';
    case 'tool_dispatch':
      return 'A tool failed';
    case 'commit_conflict':
      return 'Response discarded';
    case 'guard_exhausted':
      return 'Malformed response';
  }
}

/**
 * The italicized guidance line per kind. Two registers: provider or
 * stochastic failures read "not your fault, try again (with a when)";
 * config and state failures read "because X, do Y".
 */
export function adviceFor(kind: CompletionErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'Nak failed because your Venice API key was rejected. Update it in Settings, then retry.';
    case 'rate_limit':
      return "The AI service is overloaded - it's not your fault. Try again in a moment, or give it a few minutes to recover.";
    case 'http':
      return "The AI service had a problem. It's not your fault - try again in a moment.";
    case 'network':
      return 'The connection dropped mid-response. Check your network, then retry.';
    case 'parse':
      return "The response came back malformed. It's not your fault - retrying usually gets a clean one.";
    case 'truncated':
      return 'The response was cut off before it finished. Retrying usually completes it.';
    case 'internal':
      return "Something went wrong inside Nak. It's not your fault - retrying is safe.";
    case 'round_limit':
      return 'Nak stopped because the model kept calling tools without ever answering. Try a more focused request.';
    case 'wall_timeout':
      return 'The response took too long and hit the time limit. Try again, or break the request into smaller steps.';
    case 'tool_dispatch':
      return 'A tool Nak tried to use failed. Retrying usually works.';
    case 'commit_conflict':
      return 'The conversation changed on another device while Nak was responding, so the reply was discarded. Refresh this thread to see the latest.';
    case 'guard_exhausted':
      return 'The model kept producing garbled output. It\u2019s not your fault - retrying usually clears it.';
  }
}

// ---------------------------------------------------------------------------
// Tail classification
// ---------------------------------------------------------------------------

/**
 * The transcript-tail verdict. One classifier answers "how did the
 * last turn end?" for every consumer: the status derivation, the
 * retry dispatcher, and the diagnostics log line.
 *
 *   settled            - a complete turn; nothing to report.
 *   suspended          - a pending ask_user question; AskUserCard owns
 *                        the interaction, never banner over it.
 *   deliberate-stop    - the user pressed Stop; leave it alone.
 *   draft-pending      - a fork-and-edit draft waits at the tail.
 *   unanswered         - the user message persisted, nothing else did.
 *   interrupted-round  - a tool round completed but no reply followed
 *                        (raw tail, or a tail the recovery synthesizer
 *                        healed).
 *   stalled            - reasoning-only stall: thought, never answered.
 *                        Dead turn - retry must REPLACE the row.
 *   cut-off            - partial-text cutoff: status='error' row with
 *                        visible text. Dead turn - retry REPLACES.
 */
export type TailVerdict =
  | { kind: 'settled' }
  | { kind: 'suspended' }
  | { kind: 'deliberate-stop' }
  | { kind: 'draft-pending' }
  | { kind: 'unanswered'; anchorUserMessageId: string }
  | { kind: 'interrupted-round'; anchorUserMessageId: string }
  | { kind: 'stalled'; anchorUserMessageId: string; deleteId: string }
  | { kind: 'cut-off'; anchorUserMessageId: string; deleteId: string };

/**
 * True when `message` is a reasoning-only stall: an assistant row that
 * carries chain-of-thought but no visible content and no tool calls.
 * Seen when a model fences its tool call in a non-standard syntax (e.g.
 * DSML markers) the parser doesn't recognize - the whole turn lands in
 * `reasoning`, `content` stays empty, and `tool_calls` is null, so the
 * row renders as a bare reasoning panel with no answer.
 *
 * This shape is a DEAD turn, not a continuation point: unlike an
 * orphaned tool round (where the persisted tool result is exactly what
 * the model needs to pick up), there's nothing here for a continuation
 * to build on. Retrying it must delete the row and re-roll, otherwise
 * the empty bubble lingers above the fresh answer.
 *
 * Excludes status='aborted': a user-initiated stop is a deliberate
 * endpoint we leave alone, never a stall to retry. The aborted terminal
 * appends the interrupted marker to content (so the common
 * stop-after-some-text case already fails the !hasContent test), but a
 * stop that landed during a reasoning-only stretch produces a
 * marker-only row whose reasoning survives - the status gate, not the
 * incidental marker, is what keeps that off the retry path. The gate
 * also holds across devices: the status rides the persisted row, so a
 * second device classifies the stop the same way the device that
 * issued it would.
 */
export function isReasoningOnlyStall(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (message.status === 'aborted') return false;
  if (message.tool_calls && message.tool_calls.length > 0) return false;
  const hasContent = message.content.trim().length > 0;
  const hasReasoning = (message.reasoning ?? '').trim().length > 0;
  return !hasContent && hasReasoning;
}

/**
 * True when `message` is a partial-text cutoff: an assistant row the
 * streaming function marked `status='error'` mid-reply, carrying the
 * visible text it accumulated up to the break but no tool calls.
 *
 * Like a reasoning-only stall this is a DEAD turn for retry purposes:
 * continuing from a sentence that stops mid-thought reads disjointly,
 * so Retry REPLACES the row instead of appending a second card beneath
 * it.
 *
 * The `status='error'` gate is load-bearing: a legitimately short reply
 * that finished on its own commits as `'complete'` and must stay a
 * continuation point, never a replace target. A user-initiated stop
 * commits as `'aborted'` (carrying the interrupted marker) and is a
 * deliberate endpoint we leave alone. Only the error terminal means the
 * visible answer was genuinely cut off.
 */
export function isCutOffPartialText(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (message.tool_calls && message.tool_calls.length > 0) return false;
  if (message.status !== 'error') return false;
  return message.content.trim().length > 0;
}

/** True when the row is a pending ask_user sentinel (the chat loop is
 *  deliberately suspended waiting for the user's answer). */
function isPendingAskUser(m: Message): boolean {
  if (m.role !== 'tool') return false;
  const parsed = parseAskUserContent(m.content);
  return parsed != null && ASK_USER_PENDING_FLAG in parsed;
}

function anchorUserId(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].id;
  }
  // The tail-verdict consumers always have at least one user row in
  // scope (a completion is anchored on one), so '' is unreachable in
  // practice; it keeps the verdict type free of null handling for the
  // cold-thread edge, where no card fires anyway.
  return '';
}

/**
 * Classify the transcript tail. Reads the list AS THE CLASSIFIER SEES
 * IT - which, for thread loads, is the post-recovery-synthesis list
 * (listMessages heals wire-invalid tails before returning). The
 * classifier therefore checks `isRecoveryMessage` on the tail rather
 * than assuming raw rows: a synthetic recovery assistant at the tail
 * means the turn WAS interrupted and the synthesizer papered over it,
 * and that shape must still produce a retryable verdict instead of a
 * silent settled.
 *
 * One look-back exception: a pending ask_user sentinel is healed by
 * the synthesizer on read (its tool block runs into EOF, so a recovery
 * assistant lands after it), but that suspension is the AskUserCard's
 * interaction to own - a pending question is not a cut-off turn. The
 * classifier reads one row back through the synthetic tail to detect
 * it. On the raw in-session list (before any synthesis) the sentinel
 * is the tail itself; both shapes classify as 'suspended'.
 */
export function classifyTail(messages: readonly Message[]): TailVerdict {
  if (messages.length === 0) return { kind: 'settled' };
  const last = messages[messages.length - 1];
  const anchor = anchorUserId(messages);
  if (isRecoveryMessage(last)) {
    // Healed tail: the recovery walk appended synthetic rows. Behind
    // the synthetic recovery assistant there may be a pending ask_user
    // sentinel the walk also healed - that shape is an open question,
    // not an interruption (see classifyTail's docstring).
    const prev = messages[messages.length - 2];
    if (prev && isPendingAskUser(prev)) {
      return { kind: 'suspended' };
    }
    return { kind: 'interrupted-round', anchorUserMessageId: anchor };
  }
  if (last.role === 'tool') {
    // A pending ask_user sentinel is the chat loop intentionally
    // suspended waiting for the user to answer - not a cut-off
    // response. The AskUserCard already owns this interaction, so
    // offering a retry prompt below it would relaunch the turn out
    // from under the open question. The answered/abandoned sentinel is
    // a different story: that tail genuinely lacks a follow-up and
    // stays retry-able.
    if (isPendingAskUser(last)) return { kind: 'suspended' };
    return { kind: 'interrupted-round', anchorUserMessageId: anchor };
  }
  if (last.role === 'assistant') {
    // A user-initiated stop commits as status='aborted' (carrying the
    // interrupted marker). That is a deliberate endpoint, not a cut-off
    // turn - never offer to retry it. Checked before the tool_calls and
    // stall branches, which would otherwise flag a stop that landed
    // mid-tool-call or mid-reasoning. The status is persisted on the
    // row, so a second device that opens the thread suppresses the
    // banner the same way the device that issued the stop does.
    if (last.status === 'aborted') return { kind: 'deliberate-stop' };
    if (last.tool_calls && last.tool_calls.length > 0) {
      return { kind: 'interrupted-round', anchorUserMessageId: anchor };
    }
    if (isReasoningOnlyStall(last)) {
      return {
        kind: 'stalled',
        anchorUserMessageId: anchor,
        deleteId: last.id,
      };
    }
    if (isCutOffPartialText(last)) {
      return {
        kind: 'cut-off',
        anchorUserMessageId: anchor,
        deleteId: last.id,
      };
    }
    return { kind: 'settled' };
  }
  // A draft user message (status='draft') is the fork-and-edit flow
  // waiting for the user to edit and send - an expected state, not a
  // failed completion. Only a non-draft user message at the tail means
  // the completion never produced anything.
  if (last.status === 'draft') return { kind: 'draft-pending' };
  return { kind: 'unanswered', anchorUserMessageId: last.id };
}

// ---------------------------------------------------------------------------
// Status selection (the holistic presentation decision)
// ---------------------------------------------------------------------------

export type RetryIntent =
  | { kind: 'continue' }
  | { kind: 'replace'; deleteId: string }
  | { kind: 'draft'; userMessageId: string };

export interface CompletionStatus {
  severity: 'error' | 'note';
  title: string;
  /** Raw backend text; renders in a collapsed detail section. */
  detail?: string;
  advice: string;
  retry?: RetryIntent;
  /** Offer a discard action (the interrupted draft's escape hatch). */
  discard?: boolean;
}

/** Which surface produced the selected status. Diagnostic only. */
export type CompletionStatusSource =
  | 'none'
  | 'live-error'
  | 'persisted-error'
  | 'interrupted-draft'
  | 'tail';

export interface CompletionStatusInput {
  /** Raw messages array, post-recovery-synthesis (the Chat screen's
   *  `messages` state is exactly this). */
  messages: readonly Message[];
  /** Unified "a turn is plausibly still running" verdict: local slot
   * sending, a foreign device holding the claim, a fresh server
   * in-flight stamp, or a streaming row still parked at the tail. */
  turnPending: boolean;
  /** In-session live error from the exchange catch sites. */
  liveError: LiveError | null;
  /** The thread's persistent last_error jsonb. */
  lastError: unknown;
  /** IndexedDB draft recovered at thread load, if any. */
  draft: { userMessageId: string; threadId: string } | null;
}

/**
 * Build the card for an error envelope (live or persisted), deriving
 * the retry intent from the tail verdict so the REPLACE-vs-CONTINUE
 * decision lives in exactly one place. `retryable` gates the button;
 * a dead-tail verdict replaces, anything else continues. The live
 * envelope's context-specific retry closure takes precedence over the
 * intent at bind time (the screen checks `liveError.retry` first).
 */
function errorCard(
  kind: CompletionErrorKind,
  detail: string | undefined,
  messages: readonly Message[],
  retryable: boolean,
): CompletionStatus {
  const verdict = classifyTail(messages);
  // A settled (or deliberately-stopped / suspended / draft) tail
  // offers no re-run: the turn that produced the error either
  // completed or was intentionally ended, and re-entering would
  // re-ask an already-answered question. The live envelope's own
  // closure, when present, still binds at the template level - the
  // rate-limit mid-turn retry re-fires with its captured context.
  const settledShape =
    verdict.kind === 'settled' ||
    verdict.kind === 'deliberate-stop' ||
    verdict.kind === 'suspended' ||
    verdict.kind === 'draft-pending';
  const retry: RetryIntent | undefined = !retryable
    ? undefined
    : settledShape
      ? undefined
      : verdict.kind === 'stalled' || verdict.kind === 'cut-off'
        ? { kind: 'replace', deleteId: verdict.deleteId }
        : { kind: 'continue' };
  return {
    severity: 'error',
    title: titleFor(kind),
    detail: detail || undefined,
    advice: adviceFor(kind),
    retry,
    // Error cards are dismissible: the user may want to clear a stale
    // explanation rather than act on it. The template routes the
    // dismiss to whichever surface won (slot field, last_error column,
    // or the IndexedDB draft).
    discard: true,
  };
}

/**
 * The one status decision for the completion tail. Priority, highest
 * first:
 *
 *   1. A live turn (local or foreign) - the tail only LOOKS
 *      incomplete; render nothing and let the live surface speak.
 *   2. A live in-session error - the freshest explanation.
 *   3. The persisted last_error envelope - survives reload.
 *   4. The interrupted draft - a user tail enriched by a recoverable
 *      IndexedDB draft.
 *   5. The tail verdict's own card.
 *
 * Error cards (2, 3) derive their retry intent from the tail verdict
 * so the REPLACE-vs-CONTINUE decision is computed in exactly one
 * place, regardless of which surface won.
 */
export function selectCompletionStatus(
  input: CompletionStatusInput
): { status: CompletionStatus; source: CompletionStatusSource } | null {
  if (input.turnPending) return null;

  if (input.liveError) {
    return {
      source: 'live-error',
      status: errorCard(
        input.liveError.kind,
        input.liveError.detail,
        input.messages,
        true,
      ),
    };
  }

  const persisted = parseLastError(input.lastError);
  if (persisted) {
    return {
      source: 'persisted-error',
      status: errorCard(
        persisted.kind,
        persisted.message,
        input.messages,
        persisted.retryable,
      ),
    };
  }

  const verdict = classifyTail(input.messages);

  // A recoverable IndexedDB draft enriches the plain user-at-tail
  // verdict: same detector, richer affordances (discard). The draft's
  // userMessageId must anchor the actual tail row - a stale draft for
  // an older turn is ignored (selectThread already matches; this is
  // the same invariant restated where it's consumed).
  if (
    input.draft &&
    verdict.kind === 'unanswered' &&
    input.draft.userMessageId === input.messages[input.messages.length - 1].id
  ) {
    return {
      source: 'interrupted-draft',
      status: {
        severity: 'note',
        title: 'Previous response was interrupted',
        advice:
          'Retry to generate a new response, or discard the saved draft.',
        retry: { kind: 'draft', userMessageId: input.draft.userMessageId },
        discard: true,
      },
    };
  }

  switch (verdict.kind) {
    case 'interrupted-round':
      return {
        source: 'tail',
        status: {
          severity: 'note',
          title: 'Response interrupted mid-turn',
          advice:
            'The last tool round finished, but the reply never arrived. Retry continues from here.',
          retry: { kind: 'continue' },
        },
      };
    case 'unanswered':
      return {
        source: 'tail',
        status: {
          severity: 'note',
          title: 'No reply was generated',
          advice:
            'The last message never got a response. Retry to send it again.',
          retry: { kind: 'continue' },
        },
      };
    case 'stalled':
      return {
        source: 'tail',
        status: {
          severity: 'note',
          title: 'Response stalled',
          advice:
            'The model was thinking but never produced an answer. Retry replaces this attempt with a fresh one.',
          retry: { kind: 'replace', deleteId: verdict.deleteId },
        },
      };
    case 'cut-off':
      return {
        source: 'tail',
        status: {
          severity: 'note',
          title: 'Response cut off',
          advice:
            'Nak\u2019s reply stopped mid-sentence. Retry replaces it with a fresh response.',
          retry: { kind: 'replace', deleteId: verdict.deleteId },
        },
      };
    default:
      // settled / suspended / deliberate-stop / draft-pending: the
      // tail needs no recovery affordance.
      return null;
  }
}
