/**
 * Main-thread supervisor for the consolidated background worker.
 * Lifecycle plumbing (cross-tab lock, start / stop, log routing,
 * auth bridging) lives in `BaseWorkerManager`; this file carries
 * only the supervisor-specific payload + timing constants.
 *
 * Cross-tab singleton via `navigator.locks.request('nak:supervisor-
 * worker')`. The worker consolidates five formerly-standalone
 * features (auto_title, summary, topics, memory_topics,
 * recipe_topics) under one lease / heartbeat / auth-bridge to cut
 * the per-feature coordination overhead. See
 * `./loop.ts` for the rotation contract and which other workers
 * stayed standalone (embeddings, bias, samskara, wiki, wiki-
 * librarian).
 *
 * Timing constants:
 *
 *   - leaseTtlSeconds 300 / leaseHeartbeatMs 90_000: same shape as
 *     the other workers in the fleet after the personal-scale
 *     relax. 3.3 heartbeats per TTL window for safety against a
 *     missed beat.
 *   - threadClaimTtlSeconds 120: covers the slowest of the
 *     consolidated units (summary's smart-model call). Title /
 *     topic units fit well inside this cap.
 *   - leasePollMs 20_000: while we don't hold the supervisor
 *     lease, check every 20s. Cheap SELECT.
 *   - idleIntervalMs 300_000: when we hold the lease and every
 *     unit reports empty-phase, sleep five minutes. Personal-
 *     scale app, mobile-battery first.
 *   - errorBackoffMs 30_000: smooth over transient Venice /
 *     Supabase blips.
 */
import type { Session } from '@supabase/supabase-js';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';
import { agentModel } from '../../models';

// The supervisor takes no feature-specific start options - it drives a
// fixed set of claim-based units, none of which is parameterised at
// start. Reflection (the one unit that needed a per-user timezone for
// its day-gate) now runs server-side and reads the timezone from the
// profile directly, so BaseStartOpts (supabase + config) is the whole
// contract.

const WORKER_DEFAULTS = {
  leaseTtlSeconds: 300,
  leaseHeartbeatMs: 90_000,
  threadClaimTtlSeconds: 120,
  leasePollMs: 20_000,
  idleIntervalMs: 300_000,
  errorBackoffMs: 30_000,
};

class SupervisorManager extends BaseWorkerManager<BaseStartOpts> {
  protected readonly lockName = 'nak:supervisor-worker';
  protected readonly loggerSource = 'supervisor-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-supervisor',
    });
  }

  protected buildStartPayload(opts: BaseStartOpts, session: Session): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabasePublishableKey: opts.config.supabasePublishableKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      summaryModel: agentModel('summary').id,
      topicsModel: agentModel('topics').id,
      memoryTopicsModel: agentModel('memoryTopics').id,
      recipeTopicsModel: agentModel('recipeTopics').id,
      ...WORKER_DEFAULTS,
    };
  }
}

export const supervisorManager = new SupervisorManager();
