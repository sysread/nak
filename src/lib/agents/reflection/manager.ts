/**
 * Main-thread supervisor for the reflection Web Worker. Owns the
 * worker's lifecycle, the cross-tab Web Lock, and the wiring into
 * `state.svelte.ts` (start on unlock, stop on lock). Parallel to
 * `EmbeddingManager` in `src/lib/embeddings/manager.ts` — the two
 * workers run concurrently against different partitions of the
 * shared `worker_leases` table (worker_kind 'embedding' vs
 * 'reflection'), so one device can hold both leases simultaneously
 * without contending.
 *
 * Cross-tab singleton via `navigator.locks.request('nak:reflection-worker')`.
 * The lock request returns a Promise that stays pending while we
 * hold the lock — we resolve it from `stop()` by settling the held
 * promise, which in turn releases the lock and lets a queued tab
 * take over. Web Locks queue natively; we don't spin on acquisition.
 *
 * Tiny class rather than a module so `stop()` sees the same
 * `worker`/`lockResolver` that `start()` wrote, and so hot reloads
 * can replace the instance cleanly instead of leaking state across
 * top-level vars.
 */
import type { AppConfig } from '../../config';
import type { SupabaseService } from '../../supabase';
import { VENICE_REFLECTION_MODEL } from '../../models';
import { makeHolderId } from '../../embeddings/manager';
import {
  appendFromWorker,
  createLogger,
  isWorkerLogMessage,
} from '../../logger.svelte';

// Logger used for the legacy freeform `{type:'log'}` messages the
// worker entry still emits directly (setSession failure, lease-lost
// warning). Structured `nak-log` entries bypass this and land in the
// buffer with their original source intact.
const workerLog = createLogger('reflection-worker');

export interface StartOpts {
  /**
   * Used only to fetch the current auth session and user id — the
   * worker builds its own supabase client from the URL/key in
   * `config`, so we don't hand the main-thread client across the
   * worker boundary.
   */
  supabase: SupabaseService;
  /** Source of truth for Supabase URL + anon key + Venice API key. */
  config: AppConfig;
}

/**
 * Match these with the worker's StartMessage — any drift between the
 * two is a silent bug the TypeScript compiler can't catch (they
 * cross a structured-clone boundary, not a function call). Keep the
 * field names identical so grep finds both ends at once.
 *
 * Timing constants:
 *   - leaseTtlSeconds 45 / leaseHeartbeatMs 20_000 → two attempts
 *     per expiry window; a single failed beat stays inside the
 *     margin. Same shape as the embeddings worker.
 *   - threadClaimTtlSeconds 600 → 10 minutes is generous. A
 *     reflection can span multiple tool rounds (memory_search →
 *     memory_update → memory_search …) and each round is a Venice
 *     round-trip; TTL must cover the slowest realistic run with
 *     margin for retries.
 *   - leasePollMs 20_000 → match heartbeat cadence; cheap SELECT.
 *   - idleIntervalMs 30_000 → when holding the lease with an empty
 *     queue, poll less often than embeddings (5s) because a thread
 *     becoming reflectable is a much rarer event than a memory
 *     becoming embeddable. 30s bounds the latency from "user
 *     finished a conversation" to "reflection starts."
 *   - errorBackoffMs 10_000 → a transient Supabase/Venice failure
 *     back-off; longer than embeddings (5s) because the reflection
 *     queue moves slowly anyway.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  threadClaimTtlSeconds: 600,
  leasePollMs: 20_000,
  idleIntervalMs: 30_000,
  errorBackoffMs: 10_000,
};

export class ReflectionManager {
  private worker: Worker | null = null;
  private lockResolver: (() => void) | null = null;
  /**
   * Set true by stop() so a still-queued lock request (this tab is
   * waiting behind another tab) can bail out cleanly when it
   * finally resolves. Without this, a stop()-then-unlock race
   * would spawn a worker nobody asked for AND leak the lock.
   */
  private stopped = false;
  /**
   * Unsubscribe from the main-thread Supabase client's auth-state
   * stream. Installed by postStart() so we can forward every rotated
   * refresh token to the worker; torn down by stop(). See
   * `./worker.ts` for why the main thread is the sole refresher.
   */
  private authUnsubscribe: (() => void) | null = null;

  /**
   * Acquire the cross-tab lock and spawn the worker. Returns once
   * the worker has been posted its `start` message — NOT once it
   * has finished any reflection work. If another tab holds the lock
   * this call resolves when that tab releases (or indefinitely, if
   * it never does), so callers shouldn't `await` it on a critical
   * path; fire-and-forget.
   */
  async start(opts: StartOpts): Promise<void> {
    if (this.worker) return; // idempotent
    this.stopped = false;
    if (typeof navigator === 'undefined' || !navigator.locks) {
      // Older browsers without Web Locks run without a singleton
      // guarantee across tabs. Better than refusing to reflect at
      // all — a user with multiple tabs might pay for duplicate
      // reflection calls, but results still converge (the mark RPC
      // on whichever finishes second returns false and discards
      // the duplicate write pointer).
      this.spawn(opts);
      return;
    }
    await navigator.locks.request(
      'nak:reflection-worker',
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
    // Vite worker-url pattern — `new URL('./worker.ts', import.meta.url)` is
    // the canonical way; Vite rewrites the import at build time.
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-reflection',
    });
    worker.addEventListener('message', (evt: MessageEvent) => {
      if (isWorkerLogMessage(evt.data)) {
        // Structured log from the worker - route it into the main-
        // thread log drawer. The worker already mirrored to its own
        // console on the way out.
        appendFromWorker(evt.data.entry);
        return;
      }
      const data = evt.data as { type?: string; level?: string; message?: string };
      if (!data || typeof data !== 'object') return;
      if (data.type === 'log' && typeof data.message === 'string') {
        // Legacy freeform log shape emitted from worker.ts itself
        // (setSession failure, lease-lost warning). Funnel it
        // through the same logger so the drawer catches these too.
        const level: 'info' | 'warn' | 'error' =
          data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'info';
        workerLog[level](data.message);
      }
      // `progress` messages are informational — the UI doesn't
      // render them yet. Ignored so a future indicator can
      // subscribe without breaking this path.
    });
    this.worker = worker;
    void this.postStart(opts);
  }

  private async postStart(opts: StartOpts): Promise<void> {
    if (!this.worker) return;
    const session = await opts.supabase.getSession();
    if (!session) {
      // No session = nothing to do. Tear the worker down so we
      // don't hold the lock for nothing; state.svelte.ts will
      // re-call start() on the next unlock.
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
      reflectionModel: VENICE_REFLECTION_MODEL,
      holderId: makeHolderId(),
      ...WORKER_DEFAULTS,
    });
    // Forward every subsequent main-thread refresh to the worker —
    // its own autoRefreshToken is off, so this bridge is how it
    // learns about rotated tokens. Without it the worker's pinned
    // token would eventually be revoked by Supabase's replay
    // detection once the main thread rotated it. See `./worker.ts`.
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
   * Tell the worker to exit and release the Web Lock. Safe to call
   * when no worker is running (used as a blanket cleanup from
   * `lock()` in state.svelte.ts).
   */
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
 * activate/lock transitions and nowhere else — the manager is
 * plumbing, not something other modules should poke at directly.
 */
export const reflectionManager = new ReflectionManager();
