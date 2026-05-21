/**
 * Main-thread supervisor for the reflection Web Worker. The shared
 * lifecycle (cross-tab lock, start / stop, log routing, auth-token
 * forwarding, holder-id stamping) lives in `BaseWorkerManager`;
 * this file carries only the reflection-specific bits.
 *
 * Cross-tab singleton via
 * `navigator.locks.request('nak:reflection-worker')`. Runs
 * concurrently with the other agent workers - they partition the
 * shared `worker_leases` table on `worker_kind`, so one device
 * can hold every lease at once.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';

/**
 * Match these with the worker's `StartMessage` - any drift across
 * the structured-clone boundary is a silent runtime bug. Keep the
 * field names identical so grep finds both ends at once.
 *
 * Timing constants:
 *   - leaseTtlSeconds 90 / leaseHeartbeatMs 40_000: two attempts
 *     per expiry window; a single failed beat stays inside the
 *     margin. Same shape as the embeddings worker.
 *   - threadClaimTtlSeconds 600: 10 minutes is generous. A
 *     reflection can span multiple tool rounds (memory_search ->
 *     memory_update -> memory_search ...) and each round is a
 *     Venice round-trip; TTL must cover the slowest realistic run
 *     with margin for retries.
 *   - leasePollMs 20_000: match heartbeat cadence; cheap SELECT.
 *   - idleIntervalMs 30_000: when holding the lease with an empty
 *     queue, poll less often than embeddings (5s) because a thread
 *     becoming reflectable is a much rarer event than a memory
 *     becoming embeddable. 30s bounds the latency from "user
 *     finished a conversation" to "reflection starts."
 *   - errorBackoffMs 10_000: a transient Supabase/Venice failure
 *     back-off; longer than embeddings (5s) because the reflection
 *     queue moves slowly anyway.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 90,
  leaseHeartbeatMs: 40_000,
  threadClaimTtlSeconds: 600,
  leasePollMs: 20_000,
  idleIntervalMs: 30_000,
  errorBackoffMs: 10_000,
};

class ReflectionManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:reflection-worker';
  protected readonly loggerSource = 'reflection-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-reflection',
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
      reflectionModel: agentModel('reflection').id,
      ...WORKER_DEFAULTS,
    };
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const reflectionManager = new ReflectionManager();
