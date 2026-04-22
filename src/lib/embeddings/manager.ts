/**
 * Main-thread supervisor for the embeddings Web Worker. Owns the worker's
 * lifecycle, the Web Lock that keeps it singleton across tabs, and the
 * wiring into state.svelte.ts (start on unlock, stop on lock).
 *
 * Cross-tab singleton via `navigator.locks.request('nak:embed-worker')`.
 * The lock request returns a Promise that stays pending while we hold the
 * lock — we resolve it from `stop()` by settling the held promise, which
 * in turn releases the lock and lets a queued tab take over. Web Locks
 * have native queuing semantics; we do not spin on acquisition ourselves.
 *
 * The manager is a tiny class rather than a module because `stop()` needs
 * to see the same `worker`/`lockResolver` that `start()` wrote. A module
 * with top-level vars would work but leaks state across hot reloads; the
 * class is easier to replace with a fresh instance.
 */
import type { AppConfig } from '../config';
import type { SupabaseService } from '../supabase';
import { VENICE_EMBEDDING_MODEL } from '../models';
import {
  appendFromWorker,
  createLogger,
  isWorkerLogMessage,
} from '../logger.svelte';

// See agents/reflection/manager.ts for why this exists. Structured
// `nak-log` messages from the worker land straight in the main-thread
// buffer with their original `embed-worker` source tag; legacy
// freeform `{type:'log'}` messages go through this logger too so the
// drawer catches both shapes.
const workerLog = createLogger('embed-worker');

export interface StartOpts {
  /**
   * Used only to fetch the current auth session — the worker builds its
   * own supabase client from the URL/key in `config`, so we don't hand
   * the main-thread client across the worker boundary.
   */
  supabase: SupabaseService;
  /** Source of truth for Supabase URL + anon key + Venice API key. */
  config: AppConfig;
}

/**
 * Match these with the worker's `StartMessage` shape — any drift between
 * the two is a silent bug the TypeScript compiler can't catch (they
 * cross a structured-clone boundary, not a function call). Keep the
 * field names identical so grep finds both ends at once.
 *
 * Timing constants picked to match the lease protocol:
 *   - leaseTtlSeconds 45s / leaseHeartbeatMs 20_000 → two attempts per
 *     TTL window; a single failed beat is inside the margin.
 *   - rowClaimTtlSeconds 120 → longer than leaseTtl so a row claimed by
 *     a dying worker isn't instantly grabbed by the next lease holder;
 *     the old worker's in-flight Venice call has definitely returned
 *     before the claim expires.
 *   - leasePollMs 20_000 → while we don't hold the lease, poll at the
 *     same cadence we would've heartbeated. Cheap SELECT.
 *   - idleIntervalMs 5_000 → when we DO hold the lease and the queue
 *     is empty, poll more often so fresh memories are picked up
 *     quickly (the user may have just written one).
 *   - rateLimitBackoffMs 30_000 → Venice's 429 doesn't carry a standard
 *     retry-after; 30s is a polite default.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  rowClaimTtlSeconds: 120,
  leasePollMs: 20_000,
  idleIntervalMs: 5_000,
  errorBackoffMs: 5_000,
  rateLimitBackoffMs: 30_000,
};

/**
 * Produce a unique holder id for this worker. Used as the `holder_id`
 * stamp on both the lease and every row claim so save RPCs can prove
 * they're finishing work they started — see
 * `save_memory_embedding_if_claimed` in the schema. Uses `crypto.randomUUID`
 * when available and falls back to a Math.random-based string on the
 * very rare host that doesn't expose it. Exported for tests.
 */
export function makeHolderId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: host without crypto.randomUUID (ancient Safari). Not
  // cryptographically strong, but the id only needs to be unique
  // across a small set of peers sharing one Postgres row.
  return `holder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class EmbeddingManager {
  private worker: Worker | null = null;
  private lockResolver: (() => void) | null = null;
  /**
   * Set true by stop() so a still-queued lock request (the tab is waiting
   * behind another tab that currently owns it) can bail out cleanly when
   * it finally resolves. Without this, a stop()-then-unlock race would
   * spawn a worker that nobody asked for AND leak the lock.
   */
  private stopped = false;
  /**
   * Unsubscribe from the main-thread Supabase client's auth-state
   * stream. Installed by postStart() so we can forward every rotated
   * refresh token to the worker; torn down by stop() so we don't keep
   * posting into a terminated worker. See `./worker.ts` for why the
   * main thread is the sole refresher.
   */
  private authUnsubscribe: (() => void) | null = null;

  /**
   * Acquire the cross-tab lock and spawn the worker. Returns once the
   * worker has been posted its `start` message — NOT once it has finished
   * any embedding work. If another tab holds the lock this call resolves
   * when that tab releases (or indefinitely, if it never does), so
   * callers shouldn't `await` it on a critical path; fire-and-forget.
   */
  async start(opts: StartOpts): Promise<void> {
    if (this.worker) return; // idempotent — a double-unlock shouldn't spawn twice
    this.stopped = false;
    if (typeof navigator === 'undefined' || !navigator.locks) {
      // Older browsers without Web Locks run without a singleton guarantee.
      // Better than refusing to embed at all — users with multiple tabs
      // will pay for duplicate embeddings but results still converge.
      this.spawn(opts);
      return;
    }
    // The lock is held until the inner promise resolves. We resolve it
    // from stop() to release the lock. If acquisition blocks (another
    // tab has it), the callback doesn't run until that tab releases — so
    // we only spawn once we're the sole owner.
    await navigator.locks.request(
      'nak:embed-worker',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolveLock) => {
          // Lock acquisition can race with stop(): if the user locked the
          // app while we were queued, bail out instead of spawning.
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
    // Vite worker-url pattern: `new URL('./worker.ts', import.meta.url)` is
    // the canonical way to reference a module worker; Vite rewrites the
    // import at build time to the hashed chunk.
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-embeddings',
    });
    worker.addEventListener('message', (evt: MessageEvent) => {
      if (isWorkerLogMessage(evt.data)) {
        // Structured log from the worker - route into the main-thread
        // buffer. The worker already mirrored to its own console.
        appendFromWorker(evt.data.entry);
        return;
      }
      const data = evt.data as { type?: string; level?: string; message?: string };
      if (!data || typeof data !== 'object') return;
      if (data.type === 'log' && typeof data.message === 'string') {
        // Legacy freeform log shape emitted by the worker entry itself.
        // Keep visible at the same level so failures are still
        // surfaceable without attaching a debugger.
        const level: 'info' | 'warn' | 'error' =
          data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'info';
        workerLog[level](data.message);
      }
      // `progress` messages are currently informational — the UI doesn't
      // render them yet. Ignored on purpose so a future indicator can
      // subscribe without breaking this path.
    });
    this.worker = worker;
    // Pull the tokens synchronously off the supabase client so we can
    // package them into the one-shot start message. If there is no
    // session the worker will fail auth and exit — that's fine; the
    // manager gets restarted after sign-in via state.svelte.ts.
    void this.postStart(opts);
  }

  private async postStart(opts: StartOpts): Promise<void> {
    if (!this.worker) return;
    const session = await opts.supabase.getSession();
    if (!session) {
      // No session = nothing to do. Tear the worker down so we're not
      // holding the lock for nothing; state.svelte.ts will re-call start()
      // once the user signs in.
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
      embeddingModel: VENICE_EMBEDDING_MODEL,
      holderId: makeHolderId(),
      ...WORKER_DEFAULTS,
    });
    // Forward every subsequent main-thread refresh to the worker so
    // the two clients never diverge. With the worker's
    // autoRefreshToken off (see `./worker.ts`), this bridge is how
    // the worker learns about a rotated refresh token — without it
    // the worker's pinned token would eventually be revoked by
    // Supabase's replay detection once the main thread rotated it.
    // onAuthChange fires immediately with INITIAL_SESSION on
    // subscribe; re-sending those same tokens to the worker is a
    // harmless no-op.
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
   * Tell the worker to exit and release the Web Lock. Safe to call when
   * no worker is running (used as a blanket cleanup from `lock()` in
   * state.svelte.ts).
   */
  stop(): void {
    // Set first so a still-queued lock request (another tab holds it;
    // ours is waiting in the navigator.locks queue) bails out when it
    // finally gets granted.
    this.stopped = true;
    // Unsubscribe before terminating so we don't queue a stale
    // `session` message that never gets processed — and so a
    // concurrently-arriving auth event doesn't try to post into a
    // worker we just nulled out.
    if (this.authUnsubscribe) {
      this.authUnsubscribe();
      this.authUnsubscribe = null;
    }
    if (this.worker) {
      // Worker self-terminates on receiving `stop`; calling terminate()
      // too is belt-and-suspenders in case the worker is wedged inside a
      // long await and doesn't reach the message handler.
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
 * Single app-wide instance. Imported by state.svelte.ts's activate/lock
 * transitions and nowhere else — the manager is plumbing, not something
 * other modules should poke at directly.
 */
export const embeddingManager = new EmbeddingManager();
