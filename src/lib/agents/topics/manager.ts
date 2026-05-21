/**
 * Main-thread supervisor for the topics Web Worker. Lifecycle
 * (cross-tab lock, start / stop, log routing, auth bridging) lives
 * in `BaseWorkerManager`; this file carries only the topics-specific
 * payload + timing.
 *
 * Cross-tab singleton via
 * `navigator.locks.request('nak:topics-worker')`. Runs concurrently
 * with the other agent workers - they partition the `worker_leases`
 * table on `worker_kind` ('topics' here) so one device can hold every
 * lease at once without contending.
 *
 * The topics worker feeds the conversation-drawer's topic-filter
 * dropdown - it writes `threads.topics`, which the drawer reads via
 * `listUserTopics()` for the vocabulary and via the per-bucket list
 * queries with a `topics &&` predicate for the filter itself.
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
 *   - leaseTtlSeconds 90 / leaseHeartbeatMs 40_000: same shape as
 *     the other workers; two attempts per expiry window.
 *   - threadClaimTtlSeconds 120: mirrors summary - one non-streaming
 *     Venice call with a 512-token cap. Generous with margin.
 *   - leasePollMs 20_000: match the heartbeat; cheap SELECT.
 *   - idleIntervalMs 60_000: longer than summary because the topic
 *     vocabulary stabilises - once a thread is tagged it stays
 *     tagged until the user adds more turns, and most settled
 *     threads never re-qualify. A 60s idle nap bounds tagging
 *     latency on a busy day without burning Supabase queries on
 *     quiet ones.
 *   - errorBackoffMs 30_000: smooth over transient Venice / Supabase
 *     blips without hammering retries.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 90,
  leaseHeartbeatMs: 40_000,
  threadClaimTtlSeconds: 120,
  leasePollMs: 20_000,
  idleIntervalMs: 60_000,
  errorBackoffMs: 30_000,
};

class TopicsManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:topics-worker';
  protected readonly loggerSource = 'topics-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-topics',
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
      topicsModel: agentModel('topics').id,
      ...WORKER_DEFAULTS,
    };
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const topicsManager = new TopicsManager();
