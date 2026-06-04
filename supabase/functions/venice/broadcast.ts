// Broadcast publisher with adaptive backpressure ------------------------------
//
// Wraps a joined Supabase Realtime Broadcast channel with a buffering
// publisher that protects the project-wide msg/sec budget without
// destroying the live-stream feel for chat. The Supabase Pro tier
// gives nak ~500 msg/sec; a single fast-text turn can emit one
// response_text delta every 30-50ms (~20 msg/sec) which is comfortable
// solo but adds up under multiple concurrent streams. When the
// upstream complains, we widen the flush window per tier; when it
// stays quiet, we narrow back to the snappy default. See
// docs/dev/in-progress/venice-edge-functions/streaming-root.md
// section 2.6 for the design rationale.
//
// What gets buffered:
//
//   - response_text deltas. Concatenated within a flush window and
//     emitted as a single response_text event whose content is the
//     joined string. The browser consumer treats every incoming
//     response_text as a delta to append, so coalescing is
//     transparent at the wire level.
//   - reasoning_text deltas. Same treatment.
//
// What passes through promptly (never buffered):
//
//   - tool_call_request, tool_call_response - latency-sensitive UI
//     affordances. The tool throbber should appear the moment the
//     model calls a tool, not 250ms later because text was being
//     coalesced.
//   - END {terminalKind} - terminal marker.
//   - rate_limit_wait / rate_limit_resolved / guard_retry / stream_retry
//     - retry-lifecycle signals. The browser needs to swap the
//     streaming spinner for the "waiting on Venice" indicator
//     immediately when a 429 hits, and stream_retry's accumulator-
//     reset must reach the consumer before any new content events do
//     so the discarded prefix doesn't double up.
//   - error - terminal.
//   - usage / citations - rare; arrive at end of stream anyway.
//   - BEGIN / DONE - per-completion markers.
//
// Tier ladder (matches the plan's table):
//
//   tier 0  50ms   ~20 msg/sec     snappy native streaming (default)
//   tier 1  100ms  ~10 msg/sec     slight visible chunking
//   tier 2  250ms  ~4 msg/sec      "phrases at a time"
//   tier 3  500ms  ~2 msg/sec      "feels typed" floor
//
// State machine: start at tier 0 per invocation. Any non-'ok' send
// result bumps the tier up (clamped at tier 3). After TIER_DOWN_QUIET_MS
// without a non-'ok' result AND the publisher is past tier 0, drop one
// tier back. The check runs on every successful send; cost is one
// timestamp comparison.
//
// Calling discipline:
//
//   - publish(event) returns when the event has been buffered (text)
//     or sent (everything else). Failures don't throw - they bump the
//     tier and the event is dropped at the broker. Loss is acceptable
//     because text deltas are cumulative (next delta still has the
//     full prior content) and other events are either retried
//     upstream or terminal.
//   - flush() forces an immediate emit of any pending buffer. The
//     orchestrator MUST call this before publishing END so the
//     terminal frame is not preceded by orphaned text.
//   - dispose() cancels the in-flight flush timer. Caller still owns
//     channel.unsubscribe() afterward.

import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
} from '@supabase/supabase-js';
import type { StreamEvent } from '../_shared/venice-stream.ts';

// Flush window in ms per tier index. Tier 0 = 50ms (snappy);
// tier 3 = 500ms (floor). Bumping above tier 3 or below tier 0 is
// clamped.
const FLUSH_WINDOW_MS: readonly number[] = [50, 100, 250, 500];
const CEIL_TIER = 0;
const FLOOR_TIER = FLUSH_WINDOW_MS.length - 1;

// Quiet period required at the current tier before tier-down kicks in.
// Long enough that a brief 429 burst doesn't immediately re-narrow
// back to tier 0; short enough that a turn that hit one 429 in its
// first second recovers to snappy by the end.
const TIER_DOWN_QUIET_MS = 5_000;

export interface BroadcastPublisher {
  /**
   * Buffer or send an event according to the per-event policy above.
   * Failures bump the tier and drop the event; never throws.
   */
  publish(event: StreamEvent): Promise<void>;
  /**
   * Force-emit any pending buffered text. Call before publishing END
   * (or any terminal event) so the consumer never sees a terminal
   * without the trailing deltas that preceded it.
   */
  flush(): Promise<void>;
  /**
   * Cancel any in-flight flush timer. Caller is still responsible for
   * channel.unsubscribe() on the underlying realtime channel.
   */
  dispose(): void;
  /** Current backpressure tier (0..3). Exposed for tests / diagnostics. */
  currentTier(): number;
}

export interface CreatePublisherOpts {
  /**
   * The Realtime channel to publish on. Must already be in the
   * 'joined' state by the time publish() is called - the orchestrator
   * awaits .subscribe() and only then constructs the publisher.
   */
  channel: RealtimeChannel;
  /**
   * Wall-clock provider. Defaults to Date.now; overridable for tests
   * so they don't have to await real timers.
   */
  now?: () => number;
  /**
   * Schedule callback after a delay. Defaults to setTimeout; tests
   * inject a fake scheduler to advance the flush queue
   * deterministically.
   */
  schedule?: (cb: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

class Publisher implements BroadcastPublisher {
  private tier = CEIL_TIER;
  private textBuf = '';
  private reasoningBuf = '';
  private timerHandle: unknown = null;
  private lastBackoffAt: number;
  private readonly channel: RealtimeChannel;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(opts: CreatePublisherOpts) {
    this.channel = opts.channel;
    this.now = opts.now ?? (() => Date.now());
    this.schedule =
      opts.schedule ??
      ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.cancel =
      opts.cancel ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.lastBackoffAt = this.now();
  }

  currentTier(): number {
    return this.tier;
  }

  async publish(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case 'response_text': {
        this.textBuf += event.content;
        this.scheduleFlush();
        return;
      }
      case 'reasoning_text': {
        this.reasoningBuf += event.content;
        this.scheduleFlush();
        return;
      }
      default: {
        // Any prompt event - flush pending text first so the consumer
        // sees deltas before the structural change. Then send the
        // event itself.
        await this.flush();
        await this.send(event);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.timerHandle !== null) {
      this.cancel(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.textBuf.length > 0) {
      const content = this.textBuf;
      this.textBuf = '';
      await this.send({ type: 'response_text', content });
    }
    if (this.reasoningBuf.length > 0) {
      const content = this.reasoningBuf;
      this.reasoningBuf = '';
      await this.send({ type: 'reasoning_text', content });
    }
  }

  dispose(): void {
    if (this.timerHandle !== null) {
      this.cancel(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private scheduleFlush(): void {
    if (this.timerHandle !== null) return;
    const ms = FLUSH_WINDOW_MS[this.tier];
    this.timerHandle = this.schedule(() => {
      this.timerHandle = null;
      // flush() is async; we don't await here so the timer callback
      // returns synchronously, but the inflight publish will see the
      // resulting send before its own await resolves.
      void this.flush();
    }, ms);
  }

  private async send(event: StreamEvent): Promise<void> {
    let result: RealtimeChannelSendResponse;
    try {
      result = await this.channel.send({
        type: 'broadcast',
        event: event.type,
        payload: event,
      });
    } catch {
      // Connection-level failure (channel torn down, network drop).
      // Treat as backpressure: bump tier and move on. The orchestrator
      // owns reconnect; this publisher just keeps trying.
      this.onBackoff();
      return;
    }
    if (result === 'ok') {
      this.maybeTierDown();
      return;
    }
    // Any non-'ok' result: rate limited, timed out, or error. Bump
    // the tier so the next batches go out in larger chunks.
    this.onBackoff();
  }

  private onBackoff(): void {
    this.lastBackoffAt = this.now();
    if (this.tier < FLOOR_TIER) {
      this.tier += 1;
    }
  }

  private maybeTierDown(): void {
    if (this.tier <= CEIL_TIER) return;
    if (this.now() - this.lastBackoffAt >= TIER_DOWN_QUIET_MS) {
      this.tier -= 1;
      // Reset the quiet clock - we drop one tier per quiet window,
      // not every successful send after that.
      this.lastBackoffAt = this.now();
    }
  }
}

export function createBroadcastPublisher(
  opts: CreatePublisherOpts,
): BroadcastPublisher {
  return new Publisher(opts);
}
