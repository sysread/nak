/**
 * Per-thread "this device is producing the response" claim. Wraps the
 * three thread-response-claim RPCs (acquire / heartbeat / release) plus
 * the heartbeat interval so the chat-loop can call `acquire()`, start
 * the heartbeat, and ignore the timer plumbing.
 *
 * Distinct from `LeaseCoordinator` (src/lib/embeddings/lease.ts): that
 * one partitions by `workerKind` and holds a USER-level singleton (at
 * most one of "embedding" can run across all the user's devices). This
 * one partitions by `threadId` and holds a per-THREAD claim - multiple
 * threads can be responding in parallel (different rows). The
 * heartbeat / TTL pattern is identical, hence the structural parallel.
 *
 * Heartbeat timing: default TTL is 60s and we beat every 20s. Three
 * attempts per expiry window; two missed beats are still inside the TTL
 * margin. A device that crashes mid-turn frees its claim within 60s -
 * longer than worker_leases (45s) because chat turns legitimately run
 * longer than background agents on slow models.
 *
 * Only a false return from the heartbeat RPC is decisive - a thrown
 * error just means "couldn't check, try again," and the server-side TTL
 * is the real authority.
 */
import type { SupabaseService } from '../supabase';

/**
 * Injectable timer functions so tests can drive the heartbeat interval
 * deterministically without `vi.useFakeTimers()`. Same shape as
 * `LeaseTimers` in src/lib/embeddings/lease.ts - kept as a sibling type
 * here rather than re-exported because the two timers are independent
 * (a test that swaps one shouldn't see the other change).
 */
export interface ThreadClaimTimers {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

const realTimers: ThreadClaimTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

interface ThreadClaimConfig {
  /** Length of the claim stamped on acquire and every heartbeat, in seconds. */
  ttlSeconds: number;
  /** How often to heartbeat while holding, in milliseconds. Must be < ttlSeconds * 1000. */
  heartbeatMs: number;
}

/**
 * Default TTL / heartbeat. Chat turns can legitimately exceed the
 * 45s/20s worker-lease window on slow models, so we give ourselves
 * three heartbeat attempts per TTL expiry rather than the lease's two.
 */
export const DEFAULT_THREAD_CLAIM_CONFIG: ThreadClaimConfig = {
  ttlSeconds: 60,
  heartbeatMs: 20_000,
};

export class ThreadClaimCoordinator {
  private holding = false;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly supabase: SupabaseService,
    /**
     * The thread whose response claim this coordinator manages. One
     * coordinator per in-flight exchange; the chat-loop allocates it
     * at turn start and disposes it on end.
     */
    readonly threadId: string,
    /**
     * Stable per-tab identifier the RPCs use to recognize "is this
     * call from the holder we already have, or someone else asking?"
     * Same value across acquire / heartbeat / release calls for a
     * single coordinator instance.
     */
    readonly holderId: string,
    private readonly config: ThreadClaimConfig = DEFAULT_THREAD_CLAIM_CONFIG,
    private readonly timers: ThreadClaimTimers = realTimers
  ) {
    if (config.heartbeatMs >= config.ttlSeconds * 1000) {
      // A heartbeat interval >= TTL would let the claim expire between
      // beats under any jitter at all. Treat the config as a bug rather
      // than accept a silently-broken claim.
      throw new Error(
        `heartbeatMs (${config.heartbeatMs}) must be less than ttlSeconds*1000 (${config.ttlSeconds * 1000})`
      );
    }
  }

  get isHolding(): boolean {
    return this.holding;
  }

  /**
   * Try to take the claim. Returns true iff we hold it after the call.
   * A false means another device has a live claim on the same thread -
   * the chat-loop must surface "responding on another device" to the
   * user and bail out of the exchange.
   *
   * Idempotent: calling acquire() while we already hold it is
   * harmless - the RPC's same-holder branch refreshes the expiry.
   */
  async acquire(): Promise<boolean> {
    this.holding = await this.supabase.acquireThreadResponseClaim(
      this.threadId,
      this.holderId,
      this.config.ttlSeconds
    );
    return this.holding;
  }

  /**
   * Start the heartbeat interval. Idempotent - duplicate calls replace
   * the last-seen failure callback without stacking extra intervals.
   * No-op when we don't hold the claim (nothing to heartbeat).
   *
   * `onLost` fires when the RPC returned false (decisive loss - the
   * claim has been taken over by another device, or the thread was
   * deleted). Thrown network errors do NOT fire `onLost` - the
   * server-side TTL is the real authority, and one failed beat doesn't
   * prove we've been displaced.
   */
  startHeartbeat(onLost: () => void): void {
    this.stopHeartbeat();
    if (!this.holding) return;
    this.interval = this.timers.setInterval(() => {
      // Fire-and-forget: the interval callback can't be async or the
      // timer fires again before the previous RPC resolves on slow
      // connections, which would stack beats.
      void this.beatOnce(onLost);
    }, this.config.heartbeatMs);
  }

  /**
   * Exposed for tests that want to drive the heartbeat cadence
   * manually. In production the interval calls this from startHeartbeat.
   */
  async beatOnce(onLost: () => void): Promise<void> {
    try {
      const ok = await this.supabase.heartbeatThreadResponseClaim(
        this.threadId,
        this.holderId,
        this.config.ttlSeconds
      );
      if (!ok) {
        this.holding = false;
        this.stopHeartbeat();
        onLost();
      }
    } catch {
      // Transient - another beat will fire in `heartbeatMs`. The
      // server-side TTL handles the case where errors are persistent.
    }
  }

  stopHeartbeat(): void {
    if (this.interval) {
      this.timers.clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Release the claim on the server and stop the heartbeat. Safe to
   * call when we don't hold it. Swallows RPC errors - this runs on
   * end-of-turn (success, abort, error), and the TTL will sweep a
   * non-released claim eventually anyway. Throwing here would leak
   * into the calling chat-loop finally and turn an already-finished
   * exchange into a failed one in the user's logs.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.holding) return;
    this.holding = false;
    try {
      await this.supabase.releaseThreadResponseClaim(this.threadId, this.holderId);
    } catch {
      // Best-effort: if the release RPC fails we just wait for TTL
      // expiry on the server side.
    }
  }
}
