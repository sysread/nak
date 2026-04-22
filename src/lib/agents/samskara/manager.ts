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
import { notifySamskaraMint } from '../../samskara/events';
import {
  appendFromWorker,
  createLogger,
  isWorkerLogMessage,
} from '../../logger.svelte';

// See reflection/manager.ts for why this exists. Covers legacy
// `{type:'log'}` messages; structured `nak-log` entries land in the
// main-thread buffer directly via appendFromWorker.
const workerLog = createLogger('samskara-worker');

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
 *   - regenClaimTtlSeconds 180 — three minutes. One LLM call to
 *     summarise; if it doesn't return inside that window the claim
 *     was probably orphaned by a tab close or process crash and
 *     another device should be free to retry rather than waiting
 *     out a 20-minute parking ticket. Earlier draft used 1200s for
 *     "generous, lower priority" reasoning; in practice a hung
 *     regen blocks the always-on summary update for everyone.
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
  regenClaimTtlSeconds: 180,
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
    if (this.worker) {
      workerLog.debug('start: skipped, worker already running');
      return;
    }
    this.stopped = false;
    workerLog.debug('start: requested');
    if (typeof navigator === 'undefined' || !navigator.locks) {
      workerLog.debug('start: navigator.locks unavailable, spawning without cross-tab lock');
      this.spawn(opts);
      return;
    }
    workerLog.debug('start: requesting cross-tab lock nak:samskara-worker');
    await navigator.locks.request(
      'nak:samskara-worker',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolveLock) => {
          if (this.stopped) {
            workerLog.debug('start: lock callback fired after stop, releasing');
            resolveLock();
            return;
          }
          workerLog.debug('start: cross-tab lock acquired, spawning worker');
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
      if (isWorkerLogMessage(evt.data)) {
        appendFromWorker(evt.data.entry);
        return;
      }
      const data = evt.data as {
        type?: string;
        level?: string;
        message?: string;
        tier?: number;
        valence?: number;
        phase?: string;
        result?: string;
      };
      if (!data || typeof data !== 'object') return;
      if (data.type === 'log' && typeof data.message === 'string') {
        const level: 'info' | 'warn' | 'error' =
          data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'info';
        workerLog[level](data.message);
      } else if (
        data.type === 'progress' &&
        typeof data.phase === 'string' &&
        typeof data.result === 'string'
      ) {
        // Per-cycle heartbeat. One debug line per phase advance so the
        // user can watch the worker round-robin in the Logs drawer;
        // detailed per-phase decisions are emitted from loop.ts under
        // the same source tag.
        workerLog.debug(`cycle: ${data.phase} -> ${data.result}`);
      } else if (
        data.type === 'mint' &&
        (data.tier === 1 || data.tier === 2) &&
        typeof data.valence === 'number'
      ) {
        // Bubble to the UI toast listener via a window CustomEvent. The
        // toast component is the only listener today, but decoupling via
        // the event bus means future surfaces (debug inspector, audio
        // cue) can subscribe without touching this file.
        notifySamskaraMint({ tier: data.tier, valence: data.valence });
      }
    });
    this.worker = worker;
    // Catch postStart rejections so a thrown getSession (e.g. an
    // auth-lock timeout during cold-load) doesn't leave the worker
    // spawned-but-unstarted with the cross-tab lock still held. A
    // silent unhandled-rejection used to be the wedged-but-alive
    // failure mode that left substrate pending forever.
    void this.postStart(opts).catch((err: Error) => {
      workerLog.error('postStart failed, tearing down worker', err);
      this.stop();
    });
  }

  private async postStart(opts: StartOpts): Promise<void> {
    if (!this.worker) {
      workerLog.debug('postStart: no worker, bailing');
      return;
    }
    workerLog.debug('postStart: fetching session');
    const session = await opts.supabase.getSession();
    if (!session) {
      workerLog.warn('postStart: no session, stopping worker');
      this.stop();
      return;
    }
    workerLog.debug('postStart: posting start message to worker');
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
