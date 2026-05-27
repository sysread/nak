/**
 * Main-thread supervisor for the bias-observer Web Worker.
 * Lifecycle plumbing (cross-tab lock, start / stop, log routing,
 * auth bridging, postStart-error cleanup) lives in
 * `BaseWorkerManager`; this file carries the bias-specific bits.
 *
 * Cross-tab singleton via `navigator.locks.request('nak:bias-worker')`.
 * Runs concurrently with the other agent workers via separate
 * `worker_kind` partitioning of the shared `worker_leases` table.
 *
 * One bias-specific message channel the other managers don't use:
 *
 *   - `active-conv-ids`: live-update message the chat-loop fires
 *     when the user opens / closes a conversation. The worker
 *     excludes these from its analyze scan so it doesn't process
 *     a conversation the user might still be typing in. The
 *     manager exposes `setActiveConvIds` which the main-thread
 *     state layer calls; we forward to the worker via
 *     `postMessage`. Updates are best-effort (the worker is
 *     fire-and-forget); a missed update means at worst one
 *     analysis cycle on a conversation the user just opened, which
 *     will be re-analyzed when the user sends their next message
 *     anyway.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import {
  BaseWorkerManager,
  type BaseStartOpts,
} from '../base-manager';

/**
 * Match these with the worker's StartMessage. Drift across the
 * structured-clone boundary is invisible to TypeScript; keeping the
 * field names identical means grep finds both ends at once.
 *
 *   - leaseTtlSeconds / heartbeat / poll: same pattern as the other
 *     workers; two beats per expiry window.
 *   - claimTtlSeconds 300: generous (5 min). One LLM call against
 *     a moderately long transcript fits comfortably.
 *   - idleIntervalMs 300_000: bias work is the LEAST time-critical
 *     of any agent - the user does not see results until they
 *     open the debug modal or until a future chat-turn renders the
 *     system-prompt block. Two-minute idle keeps the worker quiet
 *     when there is genuinely nothing to do.
 *   - errorBackoffMs 30_000: transient Venice / Supabase issues.
 *   - rateLimitBackoffMs 120_000: longer than samskara's 60s. We
 *     have zero UX urgency, so back off twice as long.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 300,
  leaseHeartbeatMs: 90_000,
  claimTtlSeconds: 300,
  leasePollMs: 30_000,
  idleIntervalMs: 300_000,
  errorBackoffMs: 30_000,
  rateLimitBackoffMs: 120_000,
};

class BiasManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:bias-worker';
  protected readonly loggerSource = 'bias-worker';

  /**
   * Cached set so a setActiveConvIds call before start() is
   * remembered and forwarded once the worker spawns.
   */
  private activeConvIds: string[] = [];

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-bias',
    });
  }

  protected buildStartPayload(opts: BaseStartOpts, session: Session): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabasePublishableKey: opts.config.supabasePublishableKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      veniceApiKey: opts.config.veniceApiKey,
      fastModel: agentModel('bias').id,
      activeConvIds: this.activeConvIds,
      ...WORKER_DEFAULTS,
    };
  }

  /**
   * Update the worker's exclusion set. Called from the main-thread
   * state layer whenever the active-conversation list changes
   * (e.g. user opens a thread, switches threads, closes a tab).
   * Safe to call when the worker is not running; the cached value
   * gets folded into the next `start` payload.
   */
  setActiveConvIds(ids: readonly string[]): void {
    this.activeConvIds = Array.from(ids);
    if (this.worker) {
      this.worker.postMessage({ type: 'active-conv-ids', ids: this.activeConvIds });
    }
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and the
 * chat-loop's active-conversation tracking, nowhere else.
 */
export const biasManager = new BiasManager();
