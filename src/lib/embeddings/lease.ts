/**
 * Lease coordination for a background worker. Wraps the three lease
 * RPCs (acquire / heartbeat / release) and the heartbeat interval so
 * the surrounding loop can ignore timer plumbing and just ask
 * `coordinator.isHolding`.
 *
 * The lease is a singleton per user per worker kind across every tab,
 * every device — see the schema comments on `worker_leases` for the
 * full protocol. `workerKind` partitions the lease: `'embedding'` and
 * `'reflection'` hold independently so both kinds can run concurrently
 * as long as there's one per kind. The short version: at most one
 * worker of a given kind runs at a time, which matters because
 * duplicate work (embedding reruns, reflection reruns) costs real
 * Venice money.
 *
 * Lives under `src/lib/embeddings/` for historical reasons - it was the
 * embeddings worker's coordinator first and got generalised when the agent
 * workers arrived. The embeddings worker itself is gone (backfill runs
 * server-side via pg_cron + the venice edge function - see
 * docs/dev/embeddings.md), but this coordinator is now shared
 * infrastructure: every worker under
 * `src/lib/agents/` (supervisor, samskara, bias) constructs one,
 * partitioned by `workerKind`. The
 * directory name is a vestige; the code is fleet-wide.
 *
 * Heartbeat timing: default TTL is 45s and we beat every 20s. That's
 * two attempts per expiry window; a single missed beat is still inside
 * the TTL margin. Only a false return from the heartbeat RPC is
 * decisive — a thrown error just means "couldn't check, try again",
 * because the server-side TTL will catch any truly-dead worker.
 */
import type { SupabaseService } from '../supabase';

/**
 * Injectable timer functions so tests can drive the heartbeat interval
 * deterministically without `vi.useFakeTimers()` — keeping those two
 * test surfaces separate means a test of the lease behavior doesn't
 * accidentally freeze some other subsystem's timers.
 */
export interface LeaseTimers {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

const realTimers: LeaseTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

export interface LeaseConfig {
  /** Length of the lease stamped on acquire and every heartbeat, in seconds. */
  ttlSeconds: number;
  /** How often to heartbeat while holding, in milliseconds. Must be < ttlSeconds * 1000. */
  heartbeatMs: number;
}

export class LeaseCoordinator {
  private holding = false;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly supabase: SupabaseService,
    /**
     * Partitioning key for the lease row — 'embedding', 'reflection',
     * etc. Two coordinators with different kinds never contend; one
     * device can hold both a reflection lease and an embedding lease
     * simultaneously (different kinds, different rows).
     */
    readonly workerKind: string,
    readonly holderId: string,
    private readonly config: LeaseConfig,
    private readonly timers: LeaseTimers = realTimers
  ) {
    if (config.heartbeatMs >= config.ttlSeconds * 1000) {
      // A heartbeat interval >= TTL would let the lease expire between
      // beats under any jitter at all. Treat the config as a bug rather
      // than accept a silently-broken lease.
      throw new Error(
        `heartbeatMs (${config.heartbeatMs}) must be less than ttlSeconds*1000 (${config.ttlSeconds * 1000})`
      );
    }
  }

  get isHolding(): boolean {
    return this.holding;
  }

  /**
   * Try to take the lease. Returns true iff we hold it after the call.
   * Idempotent: calling acquire() while we already hold it is harmless —
   * the RPC's on-conflict branch treats a same-holder update as a
   * refresh of the expiry.
   */
  async acquire(): Promise<boolean> {
    this.holding = await this.supabase.acquireWorkerLease(
      this.workerKind,
      this.holderId,
      this.config.ttlSeconds
    );
    return this.holding;
  }

  /**
   * Start the heartbeat interval. Idempotent — duplicate calls replace
   * the last-seen failure callback without stacking extra intervals.
   * No-op when we don't hold the lease (nothing to heartbeat).
   *
   * `onLost` fires when the RPC returned false (decisive loss). Thrown
   * network errors do NOT fire `onLost` — the server-side TTL is the
   * real authority, and one failed beat doesn't prove we've been
   * displaced.
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
      const ok = await this.supabase.heartbeatWorkerLease(
        this.workerKind,
        this.holderId,
        this.config.ttlSeconds
      );
      if (!ok) {
        this.holding = false;
        this.stopHeartbeat();
        onLost();
      }
    } catch {
      // Transient — another beat will fire in `heartbeatMs`. The
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
   * Release the lease on the server and stop the heartbeat. Safe to
   * call when we don't hold it. Swallows RPC errors — this runs on
   * graceful shutdown, and the TTL will sweep a non-released lease
   * eventually anyway.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.holding) return;
    this.holding = false;
    try {
      await this.supabase.releaseWorkerLease(this.workerKind, this.holderId);
    } catch {
      // Best-effort: if the release RPC fails we just wait for TTL
      // expiry. Throwing here would leak into the calling `stop()`
      // path and fail a shutdown that's already committed.
    }
  }
}
