/**
 * Main-thread supervisor for the attachment-expiry Web Worker.
 * Parallels `../reflection/manager.ts` and `../summary/manager.ts` —
 * the three workers run concurrently against different partitions of
 * the shared `worker_leases` table (worker_kind 'attachment_expiry'
 * vs 'reflection' vs 'summary'), so one device can hold all three
 * leases simultaneously without contending.
 *
 * Cross-tab singleton via `navigator.locks.request('nak:attachment-expiry-worker')`.
 * Same pattern as the other managers: the lock holder's promise stays
 * pending until `stop()` settles it, which releases the lock and lets
 * a queued tab take over.
 *
 * Unlike reflection/summary, this worker doesn't talk to Venice — it
 * just calls the `expire_old_attachments` RPC on a poll. No Venice
 * API key is passed through; only the Supabase auth bits.
 */
import type { AppConfig } from '../../config';
import type { SupabaseService } from '../../supabase';
import { makeHolderId } from '../../embeddings/manager';

export interface StartOpts {
  supabase: SupabaseService;
  config: AppConfig;
}

/**
 * Keep these field names identical to the worker's StartMessage —
 * mismatched names cross structured-clone without a type error and
 * show up as silent undefineds at runtime.
 *
 * Timing constants:
 *   - leaseTtlSeconds 45 / leaseHeartbeatMs 20_000 → same shape as
 *     the other workers; two attempts per expiry window.
 *   - leasePollMs 20_000 → match the heartbeat cadence.
 *   - idleIntervalMs 3_600_000 → one hour. Expirations are a 30-day
 *     deadline; hour-granularity is more than precise enough and
 *     keeps the worker effectively free when idle.
 *   - errorBackoffMs 60_000 → a transient Supabase failure shouldn't
 *     spin — the work isn't time-sensitive.
 *   - expiryDays 30 → hardcoded retention. Matches the user doc and
 *     the comment on `message_attachments.expired_at`.
 *   - batchLimit 500 → matches the RPC's own `limit`, but the
 *     constant is kept client-side so tests can dial it down.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  leasePollMs: 20_000,
  // 1 hour. See the idle-cadence note above — precision above this is
  // wasted on a 30-day deadline.
  idleIntervalMs: 60 * 60 * 1000,
  errorBackoffMs: 60_000,
  expiryDays: 30,
  batchLimit: 500,
};

export class AttachmentExpiryManager {
  private worker: Worker | null = null;
  private lockResolver: (() => void) | null = null;
  private stopped = false;
  /**
   * Unsubscribe from the main-thread Supabase client's auth-state
   * stream. Installed by postStart() so we can forward every rotated
   * refresh token to the worker; torn down by stop(). See
   * `./worker.ts` for why the main thread is the sole refresher.
   */
  private authUnsubscribe: (() => void) | null = null;

  async start(opts: StartOpts): Promise<void> {
    if (this.worker) return;
    this.stopped = false;
    if (typeof navigator === 'undefined' || !navigator.locks) {
      this.spawn(opts);
      return;
    }
    await navigator.locks.request(
      'nak:attachment-expiry-worker',
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
      name: 'nak-attachment-expiry',
    });
    worker.addEventListener('message', (evt: MessageEvent) => {
      const data = evt.data as { type?: string; level?: string; message?: string };
      if (!data || typeof data !== 'object') return;
      if (data.type === 'log' && typeof data.message === 'string') {
        const level =
          data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'log';
        // eslint-disable-next-line no-console
        console[level]('[attachment-expiry-worker]', data.message);
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
      holderId: makeHolderId(),
      ...WORKER_DEFAULTS,
    });
    // Forward every subsequent main-thread refresh to the worker —
    // its own autoRefreshToken is off, so this bridge is how it
    // learns about rotated tokens. See `./worker.ts`.
    this.authUnsubscribe = opts.supabase.onAuthChange((next) => {
      if (!this.worker || !next) return;
      this.worker.postMessage({
        type: 'session',
        accessToken: next.access_token,
        refreshToken: next.refresh_token,
      });
    });
  }

  stop(): void {
    this.stopped = true;
    // Unsubscribe before terminating so a concurrent auth event
    // doesn't try to post into a worker we just nulled out.
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

/**
 * Single app-wide instance. Imported by state.svelte.ts's
 * activate/lock transitions and nowhere else.
 */
export const attachmentExpiryManager = new AttachmentExpiryManager();
