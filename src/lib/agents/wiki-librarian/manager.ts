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
import { wikiLibrarianRunner } from './runner.svelte';

export interface WikiLibrarianStartOpts extends BaseStartOpts {
  /**
   * User profile from Settings -> AI -> About you. Empty strings
   * are the "not set" sentinels; the prompt builder suppresses
   * the "About the user" block when both are empty. Live-updated
   * via `setProfile()`.
   */
  userName: string;
  userLocation: string;
}

/**
 * Worker timing defaults.
 *
 *   - leaseTtlSeconds 90 / leaseHeartbeatMs 40_000: same as the other
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
  leaseTtlSeconds: 90,
  leaseHeartbeatMs: 40_000,
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
      userName: opts.userName,
      userLocation: opts.userLocation,
      ...WORKER_DEFAULTS,
    };
  }

  /**
   * Bubble `progress: 'reviewed'` to the wiki change-event bus so an
   * open Wiki drawer / panel refetches whenever the librarian
   * actually moves articles around. Other progress states
   * (`too-soon` / `too-small` / `polling`) are silent.
   *
   * `busy` brackets the actual `agent.run()` call inside the worker
   * loop; we mirror it onto the shared `wikiLibrarianRunner` rune so
   * the Wiki top-bar can gray out the manual-run button while the
   * scheduled run holds the floor.
   */
  protected onWorkerMessage(data: Record<string, unknown>): boolean {
    if (data.type === 'progress' && data.result === 'reviewed') {
      emitWikiChange();
      return true;
    }
    if (data.type === 'busy' && typeof data.busy === 'boolean') {
      wikiLibrarianRunner.setWorkerBusy(data.busy);
      return true;
    }
    return false;
  }

  /**
   * Live-update the worker's user-profile fields without a
   * restart. Called by state.svelte.ts on Settings edits.
   */
  setProfile(userName: string, userLocation: string): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'profile', userName, userLocation });
  }

  /**
   * Wrap the base `stop()` to clear the shared workerBusy flag. The
   * worker self-terminates on `{type:'stop'}` so it cannot send a
   * trailing `{busy:false}`; without this reset, a stop() during an
   * in-flight cycle would leave the manual-run button disabled until
   * the next worker spawn. Calls super.stop() so the base lifecycle
   * (lock release, auth-unsubscribe, terminate()) still runs.
   */
  override stop(): void {
    wikiLibrarianRunner.setWorkerBusy(false);
    super.stop();
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const wikiLibrarianManager = new WikiLibrarianManager();
