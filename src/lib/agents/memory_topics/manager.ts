/**
 * Main-thread supervisor for the memory-topics Web Worker. Lifecycle
 * (cross-tab lock, start / stop, log routing, auth bridging) lives in
 * BaseWorkerManager; this file carries only the memory-topics-specific
 * payload + timing.
 *
 * Cross-tab singleton via `navigator.locks.request('nak:memory-topics-worker')`.
 * Runs concurrently with the other agent workers - they partition the
 * `worker_leases` table on `worker_kind` ('memory-topics' here) so one
 * device can hold every lease at once without contention.
 *
 * The memory-topics worker feeds the Memories drawer's topic-filter
 * dropdown - it writes `memories.topics`, which the drawer reads via
 * `listUserMemoryTopics()` for the vocabulary and via the search
 * paths with a `topics &&` predicate for the filter itself.
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
 *   - leaseTtlSeconds 45 / leaseHeartbeatMs 20_000: same shape as the
 *     other workers; two attempts per expiry window.
 *   - memoryClaimTtlSeconds 60: one non-streaming Venice call with a
 *     256-token cap. Shorter than the thread topics TTL (120s) because
 *     the input is a bounded single memory rather than a 120-message
 *     conversation.
 *   - leasePollMs 20_000: matches the heartbeat; cheap SELECT.
 *   - idleIntervalMs 60_000: matches the thread topics worker - tags
 *     stabilise once the memory is tagged (the trigger only re-queues
 *     on content change), so a quiet account doesn't need a tighter
 *     poll.
 *   - errorBackoffMs 30_000: smooth over transient Venice / Supabase
 *     blips without hammering retries.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  memoryClaimTtlSeconds: 60,
  leasePollMs: 20_000,
  idleIntervalMs: 60_000,
  errorBackoffMs: 30_000,
};

class MemoryTopicsManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:memory-topics-worker';
  protected readonly loggerSource = 'memory-topics-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-memory-topics',
    });
  }

  protected buildStartPayload(
    opts: BaseStartOpts,
    session: Session
  ): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabaseAnonKey: opts.config.supabaseAnonKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      veniceApiKey: opts.config.veniceApiKey,
      memoryTopicsModel: agentModel('memoryTopics').id,
      ...WORKER_DEFAULTS,
    };
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const memoryTopicsManager = new MemoryTopicsManager();
