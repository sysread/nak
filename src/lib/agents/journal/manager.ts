/**
 * Main-thread supervisor for the journaling Web Worker. Lifecycle
 * plumbing (cross-tab lock, start / stop, log routing, auth bridging)
 * lives in `BaseWorkerManager`; this file carries the journal-
 * specific bits:
 *
 *   - lock name 'nak:journal-worker' (partitions from the other
 *     agents so all workers run concurrently without contention)
 *   - extra StartOpts fields: timezone + user profile, forwarded
 *     to the worker on `start` and re-forwarded via `setTimezone`
 *     / `setProfile` when Settings edits arrive mid-session
 *   - custom `progress: 'journaled'` handling: the worker emits
 *     this after a row actually lands, and we bubble it to the
 *     in-page change-event bus so an open Journal screen refetches
 *
 * Activation is gated on `app.journalAutomaticEnabled` -
 * state.svelte.ts skips the `start()` call entirely when false;
 * Settings calls `stop()` / `start()` when the user flips the
 * toggle mid-session.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { emitJournalChange } from '../../journal-events';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';

export interface JournalStartOpts extends BaseStartOpts {
  /** IANA timezone; worker falls back to its runtime default if null. */
  timezone: string | null;
  /**
   * Free-form display name from Settings -> AI -> About you. Empty
   * string is the "not set" sentinel; both this and `userLocation`
   * are forwarded to the worker at spawn time, then live-updated
   * via `setProfile()` when the user edits either field in
   * Settings.
   */
  userName: string;
  /** Same opt-in semantics as `userName`. */
  userLocation: string;
}

/**
 * Same timing defaults as the reflection worker. Journal-ready
 * threads appear at roughly the same rate (user finished a
 * conversation) so 30s idle interval, 45s lease TTL, 10-minute
 * per-thread claim cover multi-round Venice tool loops comfortably.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  threadClaimTtlSeconds: 600,
  leasePollMs: 20_000,
  idleIntervalMs: 30_000,
  errorBackoffMs: 10_000,
};

class JournalManager extends BaseWorkerManager<JournalStartOpts> {
  protected readonly lockName = 'nak:journal-worker';
  protected readonly loggerSource = 'journal-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-journal',
    });
  }

  protected buildStartPayload(
    opts: JournalStartOpts,
    session: Session
  ): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabaseAnonKey: opts.config.supabaseAnonKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      veniceApiKey: opts.config.veniceApiKey,
      journalModel: agentModel('journal').id,
      timezone: opts.timezone,
      userName: opts.userName,
      userLocation: opts.userLocation,
      ...WORKER_DEFAULTS,
    };
  }

  /**
   * The worker posts a `progress` message after every cycle. We
   * only act on `result === 'journaled'` (a row actually landed) -
   * everything else is internal worker state. Firing the change
   * event here is what wakes the open Journal modal / drawer up:
   * the store's window listener refetches and the new entry shows
   * without a page reload.
   */
  protected onWorkerMessage(data: Record<string, unknown>): boolean {
    if (data.type === 'progress' && data.result === 'journaled') {
      emitJournalChange();
      return true;
    }
    return false;
  }

  /**
   * Live-update the worker's timezone without a restart.
   * state.svelte.ts / Settings.svelte calls this when the user
   * flips their zone. A no-op when the worker isn't running; the
   * next `start()` will pick the new value up via StartOpts.
   */
  setTimezone(timezone: string | null): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'timezone', timezone });
  }

  /**
   * Live-update the worker's user-profile fields without a
   * restart. state.svelte.ts calls this from `setUserName` /
   * `setUserLocation` so a Settings edit reaches the journal
   * worker on the next cycle - matches the timezone live-update
   * path. No-op when the worker isn't running.
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
export const journalManager = new JournalManager();
