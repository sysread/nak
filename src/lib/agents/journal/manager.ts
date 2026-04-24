/**
 * Main-thread supervisor for the journaling (Reflections) Web Worker.
 * Parallels `../reflection/manager.ts`; the only material differences:
 *
 *   - Web Lock name 'nak:journal-worker' partitions from reflection
 *     and embeddings so all three workers run concurrently on the
 *     same device without contention.
 *   - `start()` accepts a `timezone` option pulled from
 *     `app.settings.journalTimezone`; the manager forwards it to the
 *     worker at spawn time AND whenever the main thread updates it
 *     via `setTimezone()` (the user flipping their zone in Settings
 *     without a full lock/unlock cycle).
 *   - Controlled by `app.journalAutomaticEnabled`: state.svelte.ts
 *     skips the `start()` call entirely when false; Settings calls
 *     `stop()` / `start()` when the user flips the toggle mid-session.
 */
import type { AppConfig } from '../../config';
import type { SupabaseService } from '../../supabase';
import { VENICE_JOURNAL_MODEL } from './agent';
import { makeHolderId } from '../../embeddings/manager';
import {
  appendFromWorker,
  createLogger,
  isWorkerLogMessage,
} from '../../logger.svelte';

const workerLog = createLogger('journal-worker');

export interface StartOpts {
  supabase: SupabaseService;
  config: AppConfig;
  /** IANA timezone; worker falls back to its runtime default if null. */
  timezone: string | null;
}

/**
 * Same timing defaults as the reflection worker. Journal-ready threads
 * appear at roughly the same rate (user finished a conversation) so
 * 30s idle interval, 45s lease TTL, 10-minute per-thread claim cover
 * multi-round Venice tool loops comfortably.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  threadClaimTtlSeconds: 600,
  leasePollMs: 20_000,
  idleIntervalMs: 30_000,
  errorBackoffMs: 10_000,
};

export class JournalManager {
  private worker: Worker | null = null;
  private lockResolver: (() => void) | null = null;
  private stopped = false;
  private authUnsubscribe: (() => void) | null = null;

  async start(opts: StartOpts): Promise<void> {
    if (this.worker) return;
    this.stopped = false;
    if (typeof navigator === 'undefined' || !navigator.locks) {
      this.spawn(opts);
      return;
    }
    await navigator.locks.request(
      'nak:journal-worker',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolveLock) => {
          if (this.stopped) {
            resolveLock();
            return;
          }
          this.lockResolver = resolveLock;
          this.spawn(opts);
        })
    );
  }

  private spawn(opts: StartOpts): void {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-journal',
    });
    worker.addEventListener('message', (evt: MessageEvent) => {
      if (isWorkerLogMessage(evt.data)) {
        appendFromWorker(evt.data.entry);
        return;
      }
      const data = evt.data as { type?: string; level?: string; message?: string };
      if (!data || typeof data !== 'object') return;
      if (data.type === 'log' && typeof data.message === 'string') {
        const level: 'info' | 'warn' | 'error' =
          data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'info';
        workerLog[level](data.message);
      }
    });
    this.worker = worker;
    void this.postStart(opts);
  }

  private async postStart(opts: StartOpts): Promise<void> {
    if (!this.worker) return;
    const session = await opts.supabase.getSession();
    if (!session) {
      this.stop();
      return;
    }
    this.worker.postMessage({
      type: 'start',
      supabaseUrl: opts.config.supabaseUrl,
      supabaseAnonKey: opts.config.supabaseAnonKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      veniceApiKey: opts.config.veniceApiKey,
      journalModel: VENICE_JOURNAL_MODEL,
      timezone: opts.timezone,
      holderId: makeHolderId(),
      ...WORKER_DEFAULTS,
    });
    this.authUnsubscribe = opts.supabase.onAuthChange((next) => {
      if (!this.worker || !next) return;
      this.worker.postMessage({
        type: 'session',
        accessToken: next.access_token,
        refreshToken: next.refresh_token,
      });
    });
  }

  /**
   * Live-update the worker's timezone without a restart. State.svelte.ts
   * / Settings.svelte calls this when the user flips their zone. A
   * no-op when the worker isn't running.
   */
  setTimezone(timezone: string | null): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'timezone', timezone });
  }

  stop(): void {
    this.stopped = true;
    if (this.authUnsubscribe) {
      this.authUnsubscribe();
      this.authUnsubscribe = null;
    }
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.lockResolver) {
      this.lockResolver();
      this.lockResolver = null;
    }
  }
}

export const journalManager = new JournalManager();
