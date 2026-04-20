/**
 * Main-thread supervisor for the summary Web Worker. Parallels
 * `../reflection/manager.ts` — the two workers run concurrently
 * against different partitions of the shared `worker_leases` table
 * (worker_kind 'reflection' vs 'summary'), so one device can hold
 * both leases simultaneously without contending.
 *
 * Cross-tab singleton via `navigator.locks.request('nak:summary-worker')`.
 * Same pattern as the reflection manager: the lock holder's promise
 * stays pending until `stop()` settles it, which releases the lock and
 * lets a queued tab take over.
 */
import type { AppConfig } from '../../config';
import type { SupabaseService } from '../../supabase';
import { VENICE_SUMMARY_MODEL } from '../../models';
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
 *     embeddings and reflection; two attempts per expiry window.
 *   - threadClaimTtlSeconds 120 → generous for one non-streaming
 *     Venice call. Reflection uses 600s because it can span multiple
 *     tool rounds; summary has no tools, so one round is the ceiling.
 *   - leasePollMs 20_000 → match the heartbeat; cheap SELECT.
 *   - idleIntervalMs 30_000 → match reflection. New summarisable
 *     threads appear at conversation boundaries, which are rare on
 *     the "always check" cadence embeddings uses (5s); 30s bounds
 *     the end-of-conversation → summary latency.
 *   - errorBackoffMs 10_000 → match reflection; the queue moves
 *     slowly and a longer back-off smooths over transient Venice
 *     blips without hammering retries.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  threadClaimTtlSeconds: 120,
  leasePollMs: 20_000,
  idleIntervalMs: 30_000,
  errorBackoffMs: 10_000,
};

export class SummaryManager {
  private worker: Worker | null = null;
  private lockResolver: (() => void) | null = null;
  private stopped = false;

  async start(opts: StartOpts): Promise<void> {
    if (this.worker) return;
    this.stopped = false;
    if (typeof navigator === 'undefined' || !navigator.locks) {
      this.spawn(opts);
      return;
    }
    await navigator.locks.request(
      'nak:summary-worker',
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
      name: 'nak-summary',
    });
    worker.addEventListener('message', (evt: MessageEvent) => {
      const data = evt.data as { type?: string; level?: string; message?: string };
      if (!data || typeof data !== 'object') return;
      if (data.type === 'log' && typeof data.message === 'string') {
        const level =
          data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'log';
        // eslint-disable-next-line no-console
        console[level]('[summary-worker]', data.message);
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
      summaryModel: VENICE_SUMMARY_MODEL,
      holderId: makeHolderId(),
      ...WORKER_DEFAULTS,
    });
  }

  stop(): void {
    this.stopped = true;
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
export const summaryManager = new SummaryManager();
