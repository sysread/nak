/**
 * Main-thread supervisor for the samskara formation Web Worker. Owns
 * the worker's lifecycle, the cross-tab Web Lock, and the wiring into
 * `state.svelte.ts` (start on unlock, stop on lock). Parallel to the
 * embeddings/reflection/summary managers; the four workers run
 * concurrently against different partitions of the shared
 * `worker_leases` table (worker_kind 'embedding' vs 'reflection' vs
 * 'summary' vs 'samskara'), so one device can hold all four
 * leases simultaneously without contending.
 *
 * Cross-tab singleton via `navigator.locks.request('nak:samskara-worker')`.
 * Same Web-Lock pattern the other managers use; see one of them for
 * the deeper explanation of why we hold the lock until stop()
 * resolves the held promise.
 */
import type { AppConfig } from '../../config';
import type { SupabaseService } from '../../supabase';
import { MODELS } from '../../models';
import { makeHolderId } from '../../embeddings/manager';

export interface StartOpts {
  supabase: SupabaseService;
  config: AppConfig;
}

/**
 * Match these with the worker's StartMessage. Drift across the
 * structured-clone boundary is invisible to TypeScript; keeping the
 * field names identical means grep finds both ends at once.
 *
 * Timing constants:
 *   - leaseTtlSeconds 45 / leaseHeartbeatMs 20_000 — same shape as
 *     the other workers; two beats per expiry window.
 *   - claimTtlSeconds 600 — generous (10 min). Each phase claims one
 *     row and may run an LLM call; the TTL must outlast the slowest
 *     realistic call with margin.
 *   - regenClaimTtlSeconds 1200 — even more generous (20 min). The
 *     compound-summary regen is one LLM call but can be slower (long
 *     output, lower priority on Venice).
 *   - leasePollMs 20_000 — match heartbeat cadence.
 *   - idleIntervalMs 60_000 — when holding the lease and every phase
 *     said empty-phase, idle for a minute. Samskara work is much less
 *     time-critical than embeddings (the next chat-loop turn doesn't
 *     wait on it), so a longer idle is fine.
 *   - errorBackoffMs 15_000 — somewhere between embeddings (5s) and
 *     reflection (10s). Errors here are usually transient Venice
 *     hiccups.
 *   - rateLimitBackoffMs 60_000 — longer than embeddings (30s).
 *     Samskara has no UX urgency, so back off harder when Venice
 *     pushes back.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  claimTtlSeconds: 600,
  regenClaimTtlSeconds: 1200,
  leasePollMs: 20_000,
  idleIntervalMs: 60_000,
  errorBackoffMs: 15_000,
  rateLimitBackoffMs: 60_000,
};

export class SamskaraManager {
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
      'nak:samskara-worker',
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
      name: 'nak-samskara',
    });
    worker.addEventListener('message', (evt: MessageEvent) => {
      const data = evt.data as { type?: string; level?: string; message?: string };
      if (!data || typeof data !== 'object') return;
      if (data.type === 'log' && typeof data.message === 'string') {
        const level = data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'log';
        // eslint-disable-next-line no-console
        console[level]('[samskara-worker]', data.message);
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
      veniceApiKey: opts.config.veniceApiKey,
      // Fast tier — every phase is a small JSON-out call; the smart
      // tier would be wasteful and slow.
      fastModel: MODELS.fast.id,
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

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const samskaraManager = new SamskaraManager();
