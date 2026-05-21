/**
 * Main-thread supervisor for the recipe-topics Web Worker. Mirrors
 * `../memory_topics/manager.ts`; only the lock name, logger source,
 * worker filename, and start-payload field name differ.
 *
 * Cross-tab singleton via
 * `navigator.locks.request('nak:recipe-topics-worker')`. The
 * worker_leases row uses `worker_kind='recipe-topics'`, partitioning
 * it from the thread and memory topic workers so a device can hold
 * all three leases at once.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';

const WORKER_DEFAULTS = {
  leaseTtlSeconds: 300,
  leaseHeartbeatMs: 90_000,
  // Bounded single-recipe input; one fast-tier call with a 384-token
  // cap. 60s mirrors the memory-topics TTL and is comfortable margin.
  recipeClaimTtlSeconds: 60,
  leasePollMs: 20_000,
  idleIntervalMs: 300_000,
  errorBackoffMs: 30_000,
};

class RecipeTopicsManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:recipe-topics-worker';
  protected readonly loggerSource = 'recipe-topics-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-recipe-topics',
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
      recipeTopicsModel: agentModel('recipeTopics').id,
      ...WORKER_DEFAULTS,
    };
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const recipeTopicsManager = new RecipeTopicsManager();
