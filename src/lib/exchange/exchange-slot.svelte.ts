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
 *     reasoning panel. Opens on the first reasoning delta so the user
 *     watches the thinking stream in, then auto-collapses (with easing)
 *     once the reasoning crosses a length/sentence boundary
 *     (reasoningShouldCollapse) or the first answer delta arrives,
 *     whichever comes first. A short thought that never crosses the
 *     boundary stays open through to the hand-off. All of this is
 *     suppressed once reasoningUserToggled is set.
 *
 *   reasoningUserToggled - sticky "the user clicked the header" guard.
 *     Once set, the auto open/collapse above stops firing for the rest
 *     of the round; the user's explicit choice wins until the card is
 *     delivered. Reset per round.
 *
 *   reasoningStartedAt / reasoningEndedAt - timestamps bracketing the
 *     reasoning phase of a round. Drive the live elapsed-ms pill in the
 *     reasoning header; endedAt freezes it at the final thinking
 *     duration. Not persisted (live-row only, like the tool pills).
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

import { SvelteMap } from 'svelte/reactivity';
import type { Message } from '../supabase';
import type { SubconsciousOp } from '../chat/types';
import type { SubconsciousStatus } from '../ui/subconscious-status';
import type { QueuedMessage } from '../ui/message-queue';

interface StreamingError {
  text: string;
  retry?: () => void;
}

/**
 * A discarded streaming attempt, surfaced as a transient "oops, all
 * slop!" notice card. Created when an output guard re-rolls a junk
 * completion (e.g. a leaked special token; see stream-guards.ts) and
 * removed - with a CRT-power-off animation - once the replacement
 * response persists. Never written to Supabase; lives only for the
 * duration of the exchange. `dying` flips true to trigger the removal
 * animation just before the card unmounts.
 */
export interface SlopNotice {
  id: string;
  guard: string;
  dying: boolean;
}

interface ToolTiming {
  startedAt: number;
  endedAt?: number;
  error?: boolean;
}

type ToolTimings = Record<string, ToolTiming>;

/**
 * Why the in-flight controller was aborted. Read by runExchange's
 * catch to decide what to surface on the inline error banner:
 *
 *   null     - no abort (or the catch already handled a previous
 *              abort and reset the reason).
 *   'user'   - the user clicked Stop. No banner; the user knows what
 *              they did and an error message would read as theatre.
 *   'claim'  - the cross-device claim was decisively lost
 *              (heartbeat RPC returned false; another device took
 *              over). Surface a banner so the user knows their turn
 *              was preempted - the alternative is an inexplicable
 *              dead transcript with no signal about what happened.
 *
 * Plain field, not $state - no template reads it directly; the
 * runExchange catch consumes it within a synchronous block.
 */
type AbortReason = 'user' | 'claim' | null;

export class ExchangeSlot {
  sending = $state(false);
  /**
   * True while this slot is re-attaching to a turn that was already
   * in flight when the tab last had it (a backgrounded mobile PWA that
   * got discarded, a fresh tab, a hard reload). The turn runs entirely
   * inside the edge function; the browser can't resume the live
   * Broadcast stream (its events are ephemeral and were missed while we
   * were gone), so reconnect instead polls the row to a terminal state
   * and renders from the DB. `sending` is also true throughout, so every
   * "turn alive" UI surface stays lit; this flag only distinguishes the
   * throbber's label ("Reconnecting" vs "Thinking"). Reset by reset().
   */
  reconnecting = $state(false);
  streamingText = $state('');
  streamingReasoning = $state('');
  streamingReasoningOpen = $state(false);
  /**
   * Sticky guard set the moment the user clicks the reasoning header.
   * Once true, ALL automatic open/close of the reasoning panel is
   * suppressed for the rest of the round - the user's explicit choice
   * is law until the card is delivered. Reset per round (in the
   * onAssistantPersisted handler) and in reset(), so the next round's
   * reasoning starts under automation again. $state because the live
   * panel's auto-collapse logic reads it reactively.
   */
  reasoningUserToggled = $state(false);
  /**
   * performance.now() at the first reasoning delta of the current
   * round; null before any reasoning has streamed. Drives the elapsed-
   * ms pill in the live reasoning header. Reset per round and in
   * reset(). Not persisted - historical latency isn't worth a column,
   * same call as the tool-timing pills.
   */
  reasoningStartedAt = $state<number | null>(null);
  /**
   * performance.now() at the first answer (content) delta of the round,
   * which is when reasoning has effectively ended; null while reasoning
   * is still the live channel. Freezes the elapsed-ms pill at the final
   * thinking duration instead of letting it count on into the answer.
   * Reset per round and in reset().
   */
  reasoningEndedAt = $state<number | null>(null);
  /**
   * Plain field (not $state) because no template binds to it - it's
   * an internal guard read only by the chat-loop handlers. Lifting
   * it to $state would force an extra render every time the first
   * content delta of a round lands.
   */
  streamingContentStarted = false;
  streamingError = $state<StreamingError | null>(null);
  /**
   * Transient "oops, all slop!" cards for streaming attempts an output
   * guard discarded this exchange. Pushed by the onGuardRetry handler,
   * animated out once the replacement response persists. $state because
   * the transcript renders them live as the re-roll happens.
   */
  slopNotices = $state<SlopNotice[]>([]);
  rateLimitWaitUntil = $state<number | null>(null);
  rateLimitAttempt = $state(0);
  /**
   * Subconscious-priming pipelines that have fired this turn (samskara
   * fire, intuition, context recall), each mapped to running/done.
   * Populated by the chat-loop's onSubconsciousStart/End handlers; the
   * streaming bubble renders one checklist row per entry - a spinner
   * while 'running', a checkmark once 'done'. Entries persist after
   * completing (the row checks off rather than vanishing); the whole
   * checklist is dismissed at once when the response starts streaming
   * (see subconsciousDismissed). SvelteMap rather than a plain
   * `$state(new Map())` because Svelte 5's $state doesn't proxy Map
   * set/delete - without it the rows wouldn't re-render as statuses
   * flip. Reference is stable (mutated in place), so a plain readonly
   * field. The End handler only flips an entry that's still present, so
   * a late End that lands after reset() cleared the map is a no-op
   * rather than resurrecting a stale checkmark - see the handler
   * comments for why the samskara End can arrive that late.
   */
  readonly subconsciousStatus = new SvelteMap<SubconsciousOp, SubconsciousStatus>();
  /**
   * Sticky guard that retires the subconscious checklist once the actual
   * reply becomes visible. Flipped true when the first answer text paints
   * (in the chat-loop's flushPending) or on the first reasoning delta,
   * whichever comes first; the template's checklist `{#if}` reads it so
   * the rows ease-fade out as the answer begins. Tied to the moment
   * content paints rather than the first wire byte because the checklist
   * lives in the response card and the card mounts only while it has
   * content - dismissing before any content is on screen would blank the
   * card for the flush window. Sticky (not derived from streamingText)
   * because streamingText resets to '' at each round boundary - deriving
   * from it would make the checklist flicker back in between rounds.
   * Reset to false per exchange.
   */
  subconsciousDismissed = $state(false);
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
   * Why the controller was aborted, if it was. Set by the caller
   * BEFORE calling abortCtl.abort() so runExchange's catch can read
   * the reason after the abort propagates. Cleared by reset() and
   * by the catch after consumption.
   */
  abortReason: AbortReason = null;
  /**
   * Composer drafts the user banked with the submit-modifier Enter
   * while this thread's turn was streaming, in the order they pressed
   * it. Drained into real user rows by `maybeDrainQueuedMessages`
   * (Chat.svelte) once the turn settles - whether it finished on its
   * own or the user stopped it.
   *
   * Deliberately NOT cleared by `reset()`, unlike every other field
   * here: a queued message is intent about the NEXT turn, not state
   * belonging to the current one. reset() runs at the head of every
   * exchange, including the rate-limit retry closure's re-entry into
   * runExchange, so clearing here would silently eat messages the user
   * queued while watching a 429 back-off. The drain empties the array
   * itself, immediately before it persists the rows.
   *
   * $state because the transcript renders one card per entry and the
   * send/stop button changes its meaning when the array is non-empty.
   */
  queued = $state<QueuedMessage[]>([]);

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
   *
   * Does NOT clear `queued` either - that array is next-turn intent,
   * not current-turn state, and this runs at the head of every
   * exchange. See the field's own comment.
   */
  reset(): void {
    this.sending = false;
    this.reconnecting = false;
    this.streamingText = '';
    this.streamingReasoning = '';
    this.streamingReasoningOpen = false;
    this.reasoningUserToggled = false;
    this.reasoningStartedAt = null;
    this.reasoningEndedAt = null;
    this.streamingContentStarted = false;
    this.streamingError = null;
    this.slopNotices = [];
    this.rateLimitWaitUntil = null;
    this.rateLimitAttempt = 0;
    this.subconsciousStatus.clear();
    this.subconsciousDismissed = false;
    this.abortCtl = null;
    this.toolTimings = {};
    this.persistedRows = [];
    this.abortReason = null;
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

