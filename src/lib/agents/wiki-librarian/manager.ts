/**
 * Main-thread supervisor for the wiki librarian Web Worker. Same
 * shape as the per-conversation wiki manager but uses a different
 * cross-tab lock (`nak:wiki-librarian-worker`) and ships a different
 * StartOpts / payload (no timezone, but a `minIntervalSeconds` knob
 * that gates the librarian's run cadence).
 *
 * Activation is gated on `app.wikiLibrarianEnabled`; state.svelte.ts
 * skips the `start()` call when false and starts/stops the worker
 * when the user toggles it.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { emitWikiChange } from '../../wiki-events';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';

export interface WikiLibrarianStartOpts extends BaseStartOpts {
  // No live-mutable knobs at the moment - the librarian uses fixed
  // timing defaults defined below. If/when we expose a user-tunable
  // cadence, this becomes a field plus a setMinInterval() method.
  // Marker so this interface stays distinct from BaseStartOpts at
  // the type level.
  readonly _wikiLibrarian?: never;
}

/**
 * Worker timing defaults.
 *
 *   - leaseTtlSeconds 45 / leaseHeartbeatMs 20_000: same as the other
 *     agent workers.
 *   - minIntervalSeconds 12 * 3600 = 43_200: minimum 12h between
 *     successive runs (across all devices). Enforced atomically by
 *     `claim_wiki_librarian_run`.
 *   - leasePollMs 60_000: while we don't hold the lease, check once
 *     per minute. Cheaper than the per-conversation wiki worker's
 *     20s because the librarian rarely has urgent work.
 *   - idleIntervalMs 3_600_000: after a too-soon / too-small /
 *     reviewed cycle, sleep an hour before the next claim attempt.
 *     We wake up roughly every 12 cycles to re-check the claim.
 *   - errorBackoffMs 30_000: longer than the per-conversation
 *     workers' 10s; transient failures here are not urgent.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  minIntervalSeconds: 12 * 3600,
  leasePollMs: 60_000,
  idleIntervalMs: 60 * 60_000,
  errorBackoffMs: 30_000,
};

class WikiLibrarianManager extends BaseWorkerManager<WikiLibrarianStartOpts> {
  protected readonly lockName = 'nak:wiki-librarian-worker';
  protected readonly loggerSource = 'wiki-librarian-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-wiki-librarian',
    });
  }

  protected buildStartPayload(
    opts: WikiLibrarianStartOpts,
    session: Session
  ): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabaseAnonKey: opts.config.supabaseAnonKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      veniceApiKey: opts.config.veniceApiKey,
      wikiLibrarianModel: agentModel('wikiLibrarian').id,
      ...WORKER_DEFAULTS,
    };
  }

  /**
   * Bubble `progress: 'reviewed'` to the wiki change-event bus so an
   * open Wiki drawer / panel refetches whenever the librarian
   * actually moves articles around. Other progress states
   * (`too-soon` / `too-small` / `polling`) are silent.
   */
  protected onWorkerMessage(data: Record<string, unknown>): boolean {
    if (data.type === 'progress' && data.result === 'reviewed') {
      emitWikiChange();
      return true;
    }
    return false;
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const wikiLibrarianManager = new WikiLibrarianManager();
