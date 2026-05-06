/**
 * Main-thread supervisor for the summary Web Worker. Lifecycle
 * (cross-tab lock, start / stop, log routing, auth bridging) lives
 * in `BaseWorkerManager`; this file carries only the summary-
 * specific payload + timing.
 *
 * Cross-tab singleton via
 * `navigator.locks.request('nak:summary-worker')`. Runs
 * concurrently with the other agent workers - they partition the
 * `worker_leases` table on `worker_kind` so one device can hold
 * every lease at once without contending.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';

/**
 * Keep these field names identical to the worker's StartMessage -
 * mismatched names cross structured-clone without a type error and
 * show up as silent undefineds at runtime.
 *
 * Timing constants:
 *   - leaseTtlSeconds 45 / leaseHeartbeatMs 20_000: same shape as
 *     embeddings and reflection; two attempts per expiry window.
 *   - threadClaimTtlSeconds 120: generous for one non-streaming
 *     Venice call. Reflection uses 600s because it can span
 *     multiple tool rounds; summary has no tools, so one round
 *     is the ceiling.
 *   - leasePollMs 20_000: match the heartbeat; cheap SELECT.
 *   - idleIntervalMs 30_000: match reflection. Summarisable
 *     threads appear at conversation boundaries, which are rare
 *     on the "always check" cadence embeddings uses (5s); 30s
 *     bounds the end-of-conversation -> summary latency.
 *   - errorBackoffMs 10_000: match reflection; the queue moves
 *     slowly and a longer back-off smooths over transient Venice
 *     blips without hammering retries.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  threadClaimTtlSeconds: 120,
  leasePollMs: 20_000,
  idleIntervalMs: 30_000,
  errorBackoffMs: 10_000,
};

class SummaryManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:summary-worker';
  protected readonly loggerSource = 'summary-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-summary',
    });
  }

  protected buildStartPayload(opts: BaseStartOpts, session: Session): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabaseAnonKey: opts.config.supabaseAnonKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      veniceApiKey: opts.config.veniceApiKey,
      summaryModel: agentModel('summary').id,
      ...WORKER_DEFAULTS,
    };
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const summaryManager = new SummaryManager();
