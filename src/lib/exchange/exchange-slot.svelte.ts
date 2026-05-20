/**
 * One in-flight chat turn's state. Lives outside Chat.svelte so the
 * streaming-state machine is a typed unit that can be allocated,
 * inspected, and keyed per-thread (via ExchangeStore) without the
 * screen carrying it inline.
 *
 * The lifetime of a slot tracks one logical "send" - from `runExchange`
 * setting `sending = true` through every Venice round (text deltas,
 * reasoning deltas, tool calls, persisted rows) until the outer
 * finally flips `sending = false`. Rate-limit retries happen INSIDE a
 * single slot lifetime: a 429 sleep keeps `sending` asserted, populates
 * `rateLimitWaitUntil` for the bubble's countdown, then resumes the
 * same slot's state when the retry fires.
 *
 * Lifespan across exchanges: a slot persists in the ExchangeStore
 * after its exchange finishes (sending = false, streamingText = '',
 * etc.), so re-opening the same thread later finds the slot ready to
 * be re-used for the next send. `reset()` is called at the start of
 * each new exchange to clear any residual state from the previous
 * one (including persistedRows - see below).
 *
 * Field-by-field rationale (matches the comments that used to live
 * inline in Chat.svelte):
 *
 *   sending - master flag. Gates every "turn alive" UI surface for
 *     this slot's thread: the streaming bubble visibility, the stop
 *     button's mode, the composer's disabled state, the auto-scroll
 *     effect, the orphaned-tool-timings finalizer. `false` is the
 *     steady idle state.
 *
 *   streamingText - throttled buffer of `delta.content`. The chat-loop's
 *     onTextUpdate handler appends here through a 500ms trailing-edge
 *     throttle so <Markdown> doesn't re-parse on every SSE delta.
 *     Reset to '' when the assistant row persists at the end of a round.
 *
 *   streamingReasoning - companion buffer for `delta.reasoning_content`.
 *     Same lifecycle as streamingText - reset per round.
 *
 *   streamingReasoningOpen - drives the slide-open state of the live
 *     reasoning panel. Flipped on by the first reasoning delta, flipped
 *     off ~600ms after the first content delta so the user reads it as
 *     a deliberate hand-off rather than a snap close.
 *
 *   streamingContentStarted - sticky guard. Set on the first content
 *     delta of a round so a late reasoning delta can't re-open the
 *     panel after the auto-close fired. Reset per round.
 *
 *   streamingError - inline error bubble at the foot of the transcript.
 *     Carries an optional `retry` closure for rate-limit failures where
 *     re-firing the same request is the right fix.
 *
 *   rateLimitWaitUntil / rateLimitAttempt - 429 wait indicator. The
 *     chat-loop sleeps for the duration parsed from Venice's Retry-After
 *     / x-ratelimit-reset-* headers, calls onRateLimitWait with the wake
 *     time and attempt number, then onRateLimitResolved when the sleep
 *     ends. The bubble's clock-icon countdown reads these.
 *
 *   abortCtl - the outer AbortController for the chat-loop's stream
 *     consumer and every in-flight tool fetch. The stop button calls
 *     `abortCtl.abort()`; runExchange's finally nulls it. $state so
 *     the send/stop button re-renders when it flips back to null.
 *
 *   toolTimings - per-tool-call timing pills. Populated by onToolStart
 *     / onToolDone / onToolError; read by the ToolCalls component.
 *     `endedAt === undefined` is "still in flight" - the orphan
 *     finalizer (`finalizePendingToolTimings`) marks stragglers errored
 *     so a session-ending mid-tool doesn't leave a forever-spinning pill.
 *
 *   persistedRows - rows the chat-loop's onAssistantPersisted /
 *     onToolResultPersisted handlers have already persisted to Supabase
 *     during the current exchange. Mirrors what the active-thread
 *     handlers wrote into the screen's `messages` array, but kept here
 *     too so that a thread switch mid-exchange can replay them when the
 *     user comes back. Cleared by `reset()` at the start of each
 *     exchange. See `mergeMessagesById` in `exchange-store.svelte.ts`
 *     for the post-listMessages reconciliation.
 */

import type { Message } from '../supabase';

export interface StreamingError {
  text: string;
  retry?: () => void;
}

export interface ToolTiming {
  startedAt: number;
  endedAt?: number;
  error?: boolean;
}

export type ToolTimings = Record<string, ToolTiming>;

export class ExchangeSlot {
  sending = $state(false);
  streamingText = $state('');
  streamingReasoning = $state('');
  streamingReasoningOpen = $state(false);
  /**
   * Plain field (not $state) because no template binds to it - it's
   * an internal guard read only by the chat-loop handlers. Lifting
   * it to $state would force an extra render every time the first
   * content delta of a round lands.
   */
  streamingContentStarted = false;
  streamingError = $state<StreamingError | null>(null);
  rateLimitWaitUntil = $state<number | null>(null);
  rateLimitAttempt = $state(0);
  abortCtl = $state<AbortController | null>(null);
  toolTimings = $state<ToolTimings>({});
  /**
   * Persisted rows captured during the current exchange. Plain field
   * (not $state) because nothing reads it reactively - it's consumed
   * by mergeMessagesById on a thread switch, which already has the
   * fetched-snapshot to merge against. Keeping it non-reactive avoids
   * a screen-wide re-render on every persisted-row callback.
   */
  persistedRows: Message[] = [];

  /**
   * Reset every field to its idle value. Called at the start of a
   * fresh exchange so a re-run on the same slot starts from a clean
   * slate, and on slot disposal so any test that re-uses the
   * reference sees a defined post-condition. Cheap; safe to call
   * repeatedly.
   *
   * Does NOT abort an in-flight request - callers are expected to
   * have settled the lifecycle (called `abortCtl.abort()` and awaited
   * the runExchange promise) before resetting.
   */
  reset(): void {
    this.sending = false;
    this.streamingText = '';
    this.streamingReasoning = '';
    this.streamingReasoningOpen = false;
    this.streamingContentStarted = false;
    this.streamingError = null;
    this.rateLimitWaitUntil = null;
    this.rateLimitAttempt = 0;
    this.abortCtl = null;
    this.toolTimings = {};
    this.persistedRows = [];
  }

  /**
   * Finalize any tool timings that never got an endedAt. A clean run
   * sets endedAt via onToolDone / onToolError, but a stream that dies
   * mid-tool (network drop, abort, provider 5xx) leaves the timing
   * entry with just startedAt forever - which statusFor() reads as
   * "still in flight" and keeps the spinner animating indefinitely.
   * Marking the stragglers errored converts orphaned spinners into
   * red-X glyphs and prevents a later same-slot send from reviving
   * the animation when `sending` flips back to true.
   *
   * Called by runExchange's outer finally right before `sending` is
   * set to false. Idempotent.
   */
  finalizePendingToolTimings(): void {
    const now = performance.now();
    for (const id of Object.keys(this.toolTimings)) {
      const t = this.toolTimings[id];
      if (t.endedAt === undefined) {
        this.toolTimings[id] = { ...t, endedAt: now, error: true };
      }
    }
  }

  /**
   * Append a persisted row to the slot's buffer. Skips duplicates by
   * id so the realtime echo + the local persistence handler don't
   * double up if both eventually call through here.
   */
  recordPersistedRow(msg: Message): void {
    if (this.persistedRows.some((m) => m.id === msg.id)) return;
    this.persistedRows.push(msg);
  }
}

