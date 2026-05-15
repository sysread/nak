/**
 * Main-thread supervisor for the auto-title Web Worker. Lifecycle
 * (cross-tab lock, start / stop, log routing, auth bridging) lives
 * in `BaseWorkerManager`; this file carries only the auto-title-
 * specific payload + timing.
 *
 * Cross-tab singleton via
 * `navigator.locks.request('nak:auto-title-worker')`. Runs concurrently
 * with the other agent workers - they partition the `worker_leases`
 * table on `worker_kind` so one device can hold every lease at once
 * without contending.
 *
 * Why this exists as a worker rather than a fire-and-forget call from
 * Chat.svelte's send(): the in-Chat trigger lost work whenever the
 * user closed the tab (or refreshed) before the single Venice call
 * resolved, leaving the thread on the placeholder title with no retry
 * path other than the round-2+ metadata-message nag the model may or
 * may not act on. The worker re-polls the queue forever, so a fresh
 * thread that lost its first title attempt gets retried as soon as
 * the next cycle sees the row.
 */
import type { Session } from '@supabase/supabase-js';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';

/**
 * Keep these field names identical to the worker's StartMessage -
 * mismatched names cross structured-clone without a type error and
 * show up as silent undefineds at runtime.
 *
 * Timing constants:
 *   - leaseTtlSeconds 45 / leaseHeartbeatMs 20_000: same shape as
 *     the other workers; two attempts per expiry window.
 *   - threadClaimTtlSeconds 60: one non-streaming Venice call against
 *     the fast model with a 64-token cap. 60s is generous; the summary
 *     loop uses 120s because its model has more to chew on.
 *   - leasePollMs 20_000: match the heartbeat cadence.
 *   - idleIntervalMs 10_000: keep cold-start titles snappy. The user-
 *     visible latency floor on a fresh thread is roughly this number
 *     when the worker has just napped on an empty queue, so erring on
 *     the tight side here matters more than for reflection / summary
 *     where the queue moves slowly.
 *   - errorBackoffMs 30_000: smooth over transient Venice / Supabase
 *     blips without hammering retries.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  threadClaimTtlSeconds: 60,
  leasePollMs: 20_000,
  idleIntervalMs: 10_000,
  errorBackoffMs: 30_000,
};

class AutoTitleManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:auto-title-worker';
  protected readonly loggerSource = 'auto-title-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-auto-title',
    });
  }

  protected buildStartPayload(opts: BaseStartOpts, session: Session): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabaseAnonKey: opts.config.supabaseAnonKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      veniceApiKey: opts.config.veniceApiKey,
      ...WORKER_DEFAULTS,
    };
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const autoTitleManager = new AutoTitleManager();
