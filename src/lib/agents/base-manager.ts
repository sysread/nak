/**
 * Base class for every background-worker supervisor on the main
 * thread. Owns the parts that were duplicated across the previously-
 * standalone manager files (`embeddings`, `reflection`, `summary`,
 * `wiki`, `samskara`, `attachment_expiry`):
 *
 *   - cross-tab Web Lock acquisition + idempotent `start()` /
 *     `stop()` lifecycle
 *   - worker-to-main-thread message routing for the structured
 *     logger channel and the legacy `{type:'log'}` channel
 *   - Supabase auth-state forwarding so a rotated refresh token
 *     reaches the worker without a restart
 *   - `holderId` stamping on the worker's `start` message
 *   - postStart-failure cleanup so a rejected getSession (etc.)
 *     can't leak a spawned-but-unstarted worker holding the lock
 *
 * What subclasses provide:
 *
 *   - `lockName`: the unique cross-tab Web Lock identifier
 *     (e.g. 'nak:embed-worker'). Picking a unique string per
 *     subsystem is what lets every worker run concurrently on one
 *     device.
 *   - `loggerSource`: the source tag that shows up in the Logs
 *     drawer (e.g. 'embed-worker').
 *   - `createWorker()`: must construct a Worker using the inline
 *     `new URL('./worker.ts', import.meta.url)` pattern Vite needs
 *     to discover at build time. Cannot live in this base file -
 *     Vite resolves the URL relative to the calling module's
 *     `import.meta.url`, which is the subclass file.
 *   - `buildStartPayload()`: assemble the worker-specific fields
 *     of the `start` message (model id, timezone, profile, etc.).
 *     The base prepends `type: 'start'` and appends `holderId`.
 *
 * What subclasses can override but usually don't need to:
 *
 *   - `onWorkerMessage(data)`: handle worker-to-main-thread
 *     messages other than the two log channels (e.g. samskara's
 *     `mint` UI bubbles, wiki's `progress: processed` change-
 *     events). Default is a no-op.
 *
 * What subclasses CAN'T currently customise (but feel free to
 * extend if a need arises): the lock name is always namespaced
 * `nak:*`; the worker boundary always uses postMessage with a
 * single `start` / `stop` / `session` message family; the auth
 * bridge always re-uses `supabase.onAuthChange`. These are the
 * load-bearing invariants the system depends on.
 */
import type { Session } from '@supabase/supabase-js';
import type { AppConfig } from '../config';
import type { SupabaseService } from '../supabase';
import {
  appendFromWorker,
  createLogger,
  isLogLevel,
  isWorkerLogMessage,
  type Logger,
} from '../logger.svelte';
import { makeHolderId } from './holder';

export interface BaseStartOpts {
  /**
   * Used only to fetch the current auth session. The worker builds
   * its own Supabase client from the URL/key in `config`, so we
   * don't hand the main-thread client across the worker boundary.
   */
  supabase: SupabaseService;
  /** Source of truth for Supabase URL + anon key + Venice API key. */
  config: AppConfig;
}

/**
 * Abstract base. Subclass it once per worker, set the four
 * required protected members, and you get the full lifecycle for
 * free. See any concrete `manager.ts` under `src/lib/agents/` or
 * `src/lib/embeddings/` for usage.
 */
export abstract class BaseWorkerManager<O extends BaseStartOpts = BaseStartOpts> {
  /** Cross-tab Web Lock identifier. Must be unique per subsystem. */
  protected abstract readonly lockName: string;
  /** Logger source tag for the in-app Logs drawer. */
  protected abstract readonly loggerSource: string;
  /**
   * Construct a Worker with the inline
   * `new URL('./worker.ts', import.meta.url)` pattern. Do NOT call
   * this from anywhere else; the lifecycle methods below assume
   * they own the worker reference.
   */
  protected abstract createWorker(): Worker;
  /**
   * Build the worker-specific fields of the `start` message. The
   * base will prepend `type: 'start'` and append `holderId`. The
   * `session` argument is the resolved Supabase session - useful
   * for the access/refresh tokens and the user id that some
   * workers need.
   */
  protected abstract buildStartPayload(opts: O, session: Session): Record<string, unknown>;

  /**
   * Handle a worker message that wasn't a structured `nak-log` or
   * a legacy `{type:'log'}`. Return `true` if you handled it,
   * `false` to fall through (currently a no-op, since the base has
   * nothing else to do with unknown messages). Default: no-op.
   */
  protected onWorkerMessage(_data: Record<string, unknown>): boolean {
    return false;
  }

  /**
   * The worker reference. Exposed to subclasses so they can post
   * live-update messages (e.g. wiki's `setTimezone`) without
   * needing to re-implement the auth-bridge or lifecycle.
   */
  protected worker: Worker | null = null;
  private lockResolver: (() => void) | null = null;
  /**
   * Set true by `stop()` so a still-queued lock request bails out
   * cleanly when it finally resolves. Without this, a stop()-then-
   * unlock race would spawn a worker nobody asked for AND leak the
   * lock.
   */
  private stopped = false;
  /**
   * Unsubscribe from the main-thread Supabase client's auth-state
   * stream. Installed during `postStart` so we can forward every
   * rotated refresh token to the worker; torn down by `stop()`.
   * The worker's own autoRefreshToken is off (see worker.ts), so
   * this bridge is how it learns about rotated tokens - without
   * it, the worker's pinned token would eventually be revoked by
   * Supabase's replay detection once the main thread rotated it.
   */
  private authUnsubscribe: (() => void) | null = null;
  /**
   * Lazily-created so subclasses don't need to call `super()`
   * with the source name. Initialised on first spawn, kept alive
   * across stop/start cycles (no reason to recreate).
   */
  private workerLog: Logger | null = null;

  /**
   * Acquire the cross-tab Web Lock and spawn the worker. Returns
   * once the worker has been posted its `start` message, NOT once
   * any actual work completes. If another tab holds the lock this
   * call resolves when that tab releases (or never, if it doesn't),
   * so callers should fire-and-forget rather than awaiting on a
   * critical path.
   */
  async start(opts: O): Promise<void> {
    if (this.worker) return;
    this.stopped = false;
    if (typeof navigator === 'undefined' || !navigator.locks) {
      // Older browsers without Web Locks run without a singleton
      // guarantee across tabs. Better than refusing to work at all
      // - users with multiple tabs may pay for duplicate work, but
      // results still converge through the lease + claim layer.
      this.spawn(opts);
      return;
    }
    await navigator.locks.request(
      this.lockName,
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolveLock) => {
          // Lock acquisition can race with stop(): if the user
          // locked the app while we were queued behind another tab,
          // bail out instead of spawning.
          if (this.stopped) {
            resolveLock();
            return;
          }
          this.lockResolver = resolveLock;
          this.spawn(opts);
        })
    );
  }

  private spawn(opts: O): void {
    if (!this.workerLog) this.workerLog = createLogger(this.loggerSource);
    const worker = this.createWorker();
    worker.addEventListener('message', (evt: MessageEvent) => this.routeMessage(evt));
    this.worker = worker;
    // Catch postStart rejections so a thrown getSession (e.g. an
    // auth-lock timeout during cold-load) doesn't leave the worker
    // spawned-but-unstarted with the cross-tab lock still held.
    // Was previously a samskara-only safety net; now applies to
    // every manager.
    void this.runPostStart(opts);
  }

  private routeMessage(evt: MessageEvent): void {
    if (isWorkerLogMessage(evt.data)) {
      // Structured `nak-log` from the worker. The worker already
      // mirrored to its own console (in non-test builds); we just
      // append to the main-thread buffer here.
      appendFromWorker(evt.data.entry);
      return;
    }
    if (!evt.data || typeof evt.data !== 'object') return;
    const data = evt.data as Record<string, unknown>;
    if (data.type === 'log' && typeof data.message === 'string') {
      // Legacy freeform log channel emitted from worker entry code
      // before the structured logger landed. Funnel through the
      // same logger so the drawer catches both shapes.
      const log = this.workerLog;
      if (!log) return;
      const level = isLogLevel(data.level) ? data.level : 'info';
      log[level](data.message);
      return;
    }
    this.onWorkerMessage(data);
  }

  private async runPostStart(opts: O): Promise<void> {
    try {
      await this.postStart(opts);
    } catch (err) {
      this.workerLog?.error('postStart failed, tearing down worker', err);
      this.stop();
    }
  }

  private async postStart(opts: O): Promise<void> {
    if (!this.worker) return;
    const session = await opts.supabase.getSession();
    if (!session) {
      // No session = nothing to do. Tear the worker down so we're
      // not holding the lock for nothing; state.svelte.ts will
      // re-call start() on the next unlock.
      this.stop();
      return;
    }
    this.worker.postMessage({
      type: 'start',
      ...this.buildStartPayload(opts, session),
      holderId: makeHolderId(),
    });
    // Forward every subsequent main-thread refresh to the worker.
    // onAuthChange fires immediately with INITIAL_SESSION on
    // subscribe; re-sending the same tokens to the worker is a
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
   * Tell the worker to exit and release the Web Lock. Safe to call
   * when no worker is running (used as a blanket cleanup from
   * `lock()` in state.svelte.ts).
   */
  stop(): void {
    // Set first so a still-queued lock request bails out when it
    // finally gets granted (see the start() callback).
    this.stopped = true;
    // Unsubscribe before terminating so a concurrent auth event
    // doesn't try to post into a worker we just nulled out, and
    // so we don't queue a stale `session` message that the worker
    // never gets to process.
    if (this.authUnsubscribe) {
      this.authUnsubscribe();
      this.authUnsubscribe = null;
    }
    if (this.worker) {
      // Worker self-terminates on `stop`; calling terminate() too
      // is belt-and-suspenders in case the worker is wedged inside
      // a long await and never reaches the message handler.
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
