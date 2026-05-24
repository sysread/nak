/**
 * Stream output guards - generic "the completion came back wrong, throw
 * it away and re-roll" machinery for the streaming chat path.
 *
 * Some provider/model combinations occasionally emit a degenerate
 * response that isn't an error on the wire (no 4xx, a clean `[DONE]`)
 * but is useless to show the user. The first such case this module
 * handles is a leaked special token: DeepSeek-family models on Venice
 * sometimes start a response by emitting their own
 * `<｜begin▁of▁sentence｜>` token (and then a stretch of unrelated Go
 * code) instead of answering. See docs/dev/chat.md for the failure
 * mode and the wire-level fix (server-side `stop_token_ids`).
 *
 * A guard inspects an in-flight attempt and returns a verdict; the
 * async wrapper that drives the verdicts lives in chat-loop.ts
 * (`streamChatWithGuards`) because it needs the streaming generator and
 * the abort plumbing. Everything in THIS file is pure and unit-testable
 * without a Venice client or a Svelte runtime - that split is
 * deliberate so the verdict logic (the part with the subtle edge cases)
 * is exercised in isolation.
 *
 * Adding a guard for a future gotcha: write a factory returning a
 * StreamGuard, decide which models arm it in `streamGuardsFor`, and
 * lean on `combineVerdicts` to compose. The wrapper, the buffering, and
 * the retry cap are all guard-agnostic.
 *
 * Interacts with: chat-loop.ts (the async wrapper + the round consumer),
 * models/index.ts (which models arm the special-token guard, via
 * `specialTokenStopIdsFor`), venice.ts (`ChatRequest.stopTokenIds`,
 * `StreamEvent`).
 */

import type { ChatRequest } from './venice';
import { specialTokenStopIdsFor } from './models';

/**
 * What we know about one streaming attempt at the moment a guard is
 * consulted. Accumulated by the wrapper as events arrive; `ended` flips
 * true once the underlying stream returns so a guard can give a final
 * verdict on a short-but-legitimate reply it was still unsure about.
 */
export interface AttemptProgress {
  /** Concatenated `text` deltas seen so far this attempt. */
  visibleText: string;
  /** True once any `reasoning` delta has arrived. */
  sawReasoning: boolean;
  /** True once any `tool_call` event has arrived. */
  sawToolCall: boolean;
  /** True once the underlying stream has returned (no more events). */
  ended: boolean;
}

/**
 * A guard's read on the current attempt:
 *   - 'keep': commit to this attempt; flush buffered events and stream
 *     the rest through live.
 *   - 'retry': this attempt is junk; discard everything buffered and
 *     re-issue (subject to the wrapper's retry cap).
 *   - 'undecided': not enough has arrived to tell; keep buffering.
 */
export type GuardVerdict = 'keep' | 'retry' | 'undecided';

export interface StreamGuard {
  readonly name: string;
  /** Verdict on the in-progress (or just-ended) attempt. */
  verdict(progress: AttemptProgress): GuardVerdict;
  /**
   * Produce the request for the next attempt after this guard voted to
   * retry. Returns a new object; never mutates `req` in place.
   */
  prepareRetry(req: ChatRequest, attempt: number): ChatRequest;
}

/**
 * Maximum number of guard-driven retries (re-rolls) before the wrapper
 * gives up and throws GuardExhaustedError. Two re-rolls (three attempts
 * total) is enough to clear a stochastic glitch like the special-token
 * leak without spinning the user's turn indefinitely when a model is
 * stuck in a degenerate mode.
 */
export const MAX_STREAM_GUARD_RETRIES = 2;

/**
 * Temperature to force on each retry, indexed by attempt-1 (first retry
 * uses index 0). A re-roll only helps if the sample actually differs -
 * at a fixed low temperature the model re-emits the identical glitch -
 * so we override with an escalating, higher temperature on retries.
 * The first attempt is left at whatever the caller set (usually the
 * provider default), so a healthy turn pays no temperature distortion;
 * only the salvage re-rolls trade some determinism for variation.
 */
export const RETRY_TEMPERATURE_SCHEDULE: readonly number[] = [0.8, 1.0];

/**
 * Leading delimiters of leaked model special tokens. DeepSeek tokens
 * open with `<` immediately followed by U+FF5C FULLWIDTH VERTICAL LINE
 * (e.g. `<｜begin▁of▁sentence｜>`, `<｜end▁of▁sentence｜>`); llama-family
 * tokens open with `<` and an ASCII pipe (`<|eot_id|>`,
 * `<|python_tag|>`). Matching the two-character opener catches the whole
 * class of a family in one check, including tokens we haven't
 * enumerated, because stop/begin/role tokens all share the opener.
 *
 * Why the opener and not the full token string: a leaked token streams
 * in fragmented deltas, so we can only reliably see the first couple of
 * characters before we have to decide whether to keep buffering.
 */
const SPECIAL_TOKEN_LEAK_PREFIXES: readonly string[] = ['<｜', '<|'];

const MAX_LEAK_PREFIX_LEN = Math.max(
  ...SPECIAL_TOKEN_LEAK_PREFIXES.map((p) => p.length)
);

/** Strip leading whitespace without touching the rest of the string. */
function leftTrim(s: string): string {
  return s.replace(/^\s+/, '');
}

/**
 * True when `text` (already left-trimmed) opens with a known special-
 * token delimiter. A response that legitimately OPENS with one of these
 * literals - e.g. a model answering "what does `<|endoftext|>` mean?"
 * by leading with the token - would be a false positive here; that is
 * an accepted, extremely narrow cost (the re-roll usually rephrases,
 * and after the cap the user gets a manual retry). We check only the
 * opener, never mid-content, so the common case of discussing these
 * tokens later in a reply is never caught.
 */
export function startsWithSpecialTokenLeak(text: string): boolean {
  return SPECIAL_TOKEN_LEAK_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * True when `text` is too short to rule out becoming a leak opener once
 * more deltas arrive (e.g. a bare `<` that might be followed by U+FF5C).
 * Keeps the wrapper buffering one more event instead of prematurely
 * committing to a reply that could still turn out to be a leak.
 */
function couldStillBecomeLeak(text: string): boolean {
  if (text.length === 0 || text.length >= MAX_LEAK_PREFIX_LEN) return false;
  return SPECIAL_TOKEN_LEAK_PREFIXES.some((p) => p.startsWith(text));
}

/**
 * Guard for the leaked-special-token failure mode. Armed only on models
 * configured with `specialTokenStopIdsFor` (see `streamGuardsFor`), so
 * the empty-completion branch can't misfire on a model that simply had
 * nothing to say.
 *
 * Verdict logic, in order:
 *   - any reasoning or tool-call output -> 'keep'. A leak emits its
 *     token at position 0 with no reasoning and no tool call, so the
 *     presence of either means this is a real attempt.
 *   - visible text opens with a leak delimiter -> 'retry'. This is the
 *     load-bearing detector: it fires even when the server-side
 *     `stop_token_ids` halt didn't (provider honored it differently),
 *     catching the leak as it streams.
 *   - no visible text yet: 'undecided' until the stream ends, then
 *     'retry'. With the server-side stop armed, a leak manifests as an
 *     empty completion (the model was halted at its first token).
 *   - a bare partial that could still become a leak opener ->
 *     'undecided' (buffer one more delta).
 *   - otherwise -> 'keep'.
 */
export function specialTokenLeakGuard(): StreamGuard {
  return {
    name: 'special-token-leak',
    verdict(p: AttemptProgress): GuardVerdict {
      if (p.sawReasoning || p.sawToolCall) return 'keep';
      const text = leftTrim(p.visibleText);
      if (startsWithSpecialTokenLeak(text)) return 'retry';
      if (text.length === 0) return p.ended ? 'retry' : 'undecided';
      if (!p.ended && couldStillBecomeLeak(text)) return 'undecided';
      return 'keep';
    },
    prepareRetry(req: ChatRequest, attempt: number): ChatRequest {
      const idx = Math.min(attempt - 1, RETRY_TEMPERATURE_SCHEDULE.length - 1);
      return { ...req, temperature: RETRY_TEMPERATURE_SCHEDULE[idx] };
    },
  };
}

/**
 * Combine per-guard verdicts into the wrapper's decision. Any 'retry'
 * wins (one guard rejecting the attempt is enough to re-roll). Failing
 * that, any 'undecided' holds the decision open (keep buffering). Only
 * when every guard is satisfied do we 'keep'.
 */
export function combineVerdicts(verdicts: readonly GuardVerdict[]): GuardVerdict {
  if (verdicts.some((v) => v === 'retry')) return 'retry';
  if (verdicts.some((v) => v === 'undecided')) return 'undecided';
  return 'keep';
}

/**
 * The guards to arm for a given concrete model id. A model gets the
 * special-token guard exactly when it's configured with leaked-token
 * stop ids, so the wire-level stop and the client-side detector stay in
 * lockstep from one source of truth. Models with no configured gotchas
 * get an empty list and the wrapper degenerates to a pass-through.
 */
export function streamGuardsFor(modelId: string): StreamGuard[] {
  return specialTokenStopIdsFor(modelId) ? [specialTokenLeakGuard()] : [];
}

/**
 * Thrown by `streamChatWithGuards` when a guard kept voting to retry
 * past the cap. Distinct from VeniceError so the UI can surface it with
 * its own copy ("the model kept emitting a glitch") and a manual-retry
 * affordance rather than treating it as a transport failure.
 */
export class GuardExhaustedError extends Error {
  readonly guard: string;
  readonly attempts: number;
  constructor(guard: string, attempts: number) {
    super(`Stream guard "${guard}" exhausted after ${attempts} attempts`);
    this.name = 'GuardExhaustedError';
    this.guard = guard;
    this.attempts = attempts;
  }
}
