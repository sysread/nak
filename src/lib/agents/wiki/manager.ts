/**
 * Main-thread supervisor for the wiki Web Worker. Lifecycle
 * (cross-tab lock, start/stop, log routing, auth bridging) lives in
 * `BaseWorkerManager`; this file carries only the wiki-specific bits:
 *
 *   - lock name `nak:wiki-worker`
 *   - StartOpts add `timezone` (the user's display timezone, used
 *     to bucket day-eligible threads)
 *   - `progress: 'processed'` bubbles up to `emitWikiChange()` so an
 *     open Wiki drawer / panel refetches when the worker writes
 *
 * Activation is gated on `app.wikiAutomaticEnabled` -
 * state.svelte.ts skips the `start()` call entirely when false;
 * Settings calls `stop()` / `start()` when the user flips the
 * toggle mid-session.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { emitWikiChange } from '../../wiki-events';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';

export interface WikiStartOpts extends BaseStartOpts {
  /** IANA timezone; worker falls back to UTC if null. */
  timezone: string | null;
  /**
   * Free-form display name from Settings -> AI -> About you. Empty
   * string is the "not set" sentinel; the prompt builder
   * suppresses the "About the user" block when both this and
   * `userLocation` are empty. Live-updated via `setProfile()`.
   */
  userName: string;
  /** Same opt-in semantics as `userName`. */
  userLocation: string;
}

/**
 * Same timing defaults as the reflection worker. Wiki-eligible
 * threads appear at roughly the same rate (one calendar day after a
 * settled conversation) so identical knobs are fine.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 300,
  leaseHeartbeatMs: 90_000,
  threadClaimTtlSeconds: 600,
  leasePollMs: 20_000,
  idleIntervalMs: 180_000,
  errorBackoffMs: 10_000,
  // Three consecutive agent errors against the same terminal message
  // before the loop gives up and advances the pointer. Tuned for the
  // dominant failure shape we've observed - Venice's content
  // classifier rejecting a conversation body - where retries can't
  // succeed because the input doesn't change between attempts. The
  // counter resets on the next successful run, so a transient blip
  // doesn't shorten future retry budget.
  maxFailuresPerThread: 3,
};

class WikiManager extends BaseWorkerManager<WikiStartOpts> {
  protected readonly lockName = 'nak:wiki-worker';
  protected readonly loggerSource = 'wiki-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-wiki',
    });
  }

  protected buildStartPayload(
    opts: WikiStartOpts,
    session: Session
  ): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabasePublishableKey: opts.config.supabasePublishableKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      wikiModel: agentModel('wiki').id,
      timezone: opts.timezone,
      userName: opts.userName,
      userLocation: opts.userLocation,
      ...WORKER_DEFAULTS,
    };
  }

  protected onWorkerMessage(data: Record<string, unknown>): boolean {
    if (data.type === 'progress' && data.result === 'processed') {
      emitWikiChange();
      return true;
    }
    return false;
  }

  /**
   * Live-update the worker's timezone without a restart. Called by
   * state.svelte.ts when `setDisplayTimezone` runs. No-op when the
   * worker isn't running; the next `start()` picks the new value
   * off StartOpts.
   */
  setTimezone(timezone: string | null): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'timezone', timezone });
  }

  /**
   * Live-update the worker's user-profile fields without a restart.
   * The user editing their name or location in Settings reaches the
   * next cycle without tearing the worker down.
   */
  setProfile(userName: string, userLocation: string): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'profile', userName, userLocation });
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const wikiManager = new WikiManager();
