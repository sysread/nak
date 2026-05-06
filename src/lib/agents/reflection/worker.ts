/**
 * Background reflection worker — the Web Worker entry point. Parallels
 * `src/lib/embeddings/worker.ts` in shape; the process work lives in
 * `./loop.ts` and the cross-tab singleton coordination lives in the
 * manager. This file is the message boundary: construct clients from
 * the `start` message, instantiate the ReflectionAgent, and drive
 * `runOneCycle` until abort.
 *
 * Lifecycle:
 *
 *   start-msg ─► build clients ─► outer-loop: runOneCycle → sleep
 *                                              according to result
 *   stop-msg  ─► abort signal ─► release lease ─► self.close()
 *
 * Why a dedicated worker over a service worker: same rationale as
 * embeddings. Service workers have an opinionated lifecycle (the
 * runtime is free to kill idle SWs) that fights a long-lived
 * background loop. A dedicated Worker lives exactly as long as we
 * want — until `stop` or the tab closes.
 *
 * Why the worker builds its own VeniceClient + SupabaseClient rather
 * than receiving them via postMessage: class instances don't
 * structured-clone. The main-thread instances live on unaffected; we
 * reconstruct here from plain strings (URL, keys, tokens).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { VeniceClient } from '../../venice';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
import { ReflectionAgent } from './agent';
import {
  runOneCycle,
  napForResult,
  type CycleContext,
  type NapConfig,
} from './loop';

interface StartMessage {
  type: 'start';
  supabaseUrl: string;
  supabaseAnonKey: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  veniceApiKey: string;
  veniceBaseUrl?: string;
  reflectionModel: string;
  holderId: string;
  /** Per-thread claim TTL, seconds — generous because reflection spans multiple Venice round-trips. */
  threadClaimTtlSeconds: number;
  /** Lease TTL, seconds. */
  leaseTtlSeconds: number;
  /** Heartbeat interval for the lease, ms. Must be < leaseTtlSeconds*1000. */
  leaseHeartbeatMs: number;
  /** Poll interval while we don't hold the lease, ms. */
  leasePollMs: number;
  /** Idle sleep when we hold the lease but the queue is empty, ms. */
  idleIntervalMs: number;
  /** Short back-off after a transient error, ms. */
  errorBackoffMs: number;
}

interface StopMessage {
  type: 'stop';
}

/**
 * Sent by the manager whenever the main-thread Supabase client rotates
 * its refresh token. The worker re-pins via setSession so all five
 * Supabase clients in the tab (main + embeddings + this + summary +
 * attachment-expiry) share whichever refresh token the main thread
 * just minted. See runWorker's preamble for why autoRefreshToken is
 * off on this side.
 */
interface SessionMessage {
  type: 'session';
  accessToken: string;
  refreshToken: string;
}

type InboundMessage = StartMessage | StopMessage | SessionMessage;

interface LogOutbound {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface ProgressOutbound {
  type: 'progress';
  /** Matches the `CycleResult` union in loop.ts; kept loose to avoid a runtime dependency. */
  result: string;
  /** Optional thread id the reflection acted on (populated on `reflected`, `claim-lost`). */
  threadId?: string;
}

// Dedicated-worker global scope. We cast because with both DOM and
// WebWorker libs enabled TypeScript widens `self`.
const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound | ProgressOutbound): void {
  workerGlobal.postMessage(msg);
}

// Module-scope handle to the currently-running worker's Supabase
// client. Set by runWorker after its initial setSession succeeds,
// cleared on teardown. The `session` inbound message handler uses
// this to hand off rotated tokens without capturing runWorker's
// closure. Null before the initial setSession completes — a stray
// `session` message in that window is harmless because the start
// message already carried the same tokens.
let currentClient: SupabaseClient | null = null;

/**
 * Signal-aware sleep. Exits early on abort so a `stop` message
 * doesn't wait out a 30-second idle tick. Duplicated from
 * embeddings/loop.ts rather than shared — it's three lines, and
 * linking across subsystems for a utility this small makes the
 * worker entry points harder to read.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

async function runWorker(msg: StartMessage, signal: AbortSignal): Promise<void> {
  // See embeddings/worker.ts for why we build a fresh client rather
  // than receiving one — class instances don't structured-clone. And
  // see that file's runWorker preamble for why autoRefreshToken is
  // off: five independent clients racing to rotate the refresh token
  // tripped Supabase's replay-detection and revoked the session.
  // The main thread refreshes; the manager forwards the new tokens
  // via a `session` message that this worker re-pins via setSession.
  const client: SupabaseClient = createClient(msg.supabaseUrl, msg.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { error: sessionError } = await client.auth.setSession({
    access_token: msg.accessToken,
    refresh_token: msg.refreshToken,
  });
  if (sessionError) {
    post({
      type: 'log',
      level: 'error',
      message: `reflection worker setSession failed: ${sessionError.message}`,
    });
    return;
  }
  // Publish the live client so the module-scope 'session' handler can
  // hand off rotated tokens. Cleared in the finally block below.
  currentClient = client;

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabaseAnonKey: msg.supabaseAnonKey },
    { client }
  );
  const venice = new VeniceClient({
    apiKey: msg.veniceApiKey,
    baseUrl: msg.veniceBaseUrl,
  });
  const coordinator = new LeaseCoordinator(supabase, 'reflection', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  const agent = new ReflectionAgent(venice, supabase, msg.reflectionModel);

  const napConfig: NapConfig = {
    leasePollMs: msg.leasePollMs,
    idleIntervalMs: msg.idleIntervalMs,
    errorBackoffMs: msg.errorBackoffMs,
  };

  try {
    while (!signal.aborted) {
      const ctx: CycleContext = {
        agent,
        supabase,
        coordinator,
        holderId: msg.holderId,
        userId: msg.userId,
        threadClaimTtlSeconds: msg.threadClaimTtlSeconds,
        signal,
        onLeaseLost: () => {
          // Next cycle's top check sees isHolding===false and falls
          // into the polling branch; no special wake-up needed.
          post({
            type: 'log',
            level: 'warn',
            message: 'reflection lease lost — re-entering polling',
          });
        },
      };
      const result = await runOneCycle(ctx);
      post({ type: 'progress', result });
      const nap = napForResult(result, napConfig);
      if (nap > 0) await sleep(nap, signal);
    }
  } finally {
    // Unpublish before release so a late-arriving `session` message
    // after teardown is a no-op rather than a setSession on a dead
    // loop.
    currentClient = null;
    // Graceful release — best-effort, swallows errors. The server-
    // side TTL would sweep anyway, but an explicit release lets
    // another device take over instantly on a lock/sign-out.
    await coordinator.release();
  }
}

// Abort controller wires the `stop` message to the inner loop/sleep
// so a tab close or explicit stop exits in milliseconds instead of
// waiting out an idle tick.
const controller = new AbortController();

workerGlobal.addEventListener('message', (evt: MessageEvent<InboundMessage>) => {
  const msg = evt.data;
  if (msg.type === 'start') {
    runWorker(msg, controller.signal)
      .catch((err: Error) => {
        post({
          type: 'log',
          level: 'error',
          message: `reflection worker loop crashed: ${err.message}`,
        });
      })
      .finally(() => {
        // Self-terminate so the manager's Web Lock releases and any
        // other tab queued on the lock can take over.
        workerGlobal.close();
      });
  } else if (msg.type === 'stop') {
    controller.abort();
  } else if (msg.type === 'session') {
    // Re-pin rotated tokens from the main thread. See runWorker's
    // preamble for why the worker doesn't refresh on its own.
    if (!currentClient) return;
    void currentClient.auth
      .setSession({
        access_token: msg.accessToken,
        refresh_token: msg.refreshToken,
      })
      .catch((err: Error) => {
        post({
          type: 'log',
          level: 'warn',
          message: `forwarded setSession failed: ${err.message}`,
        });
      });
  }
});

// Also export the sleep helper so tests can drive it if they ever
// want to. The worker entry is self-executing above; the export is
// dead code at runtime in the Worker context.
export { sleep };

// Keep unused-import diagnostics quiet — these symbols are referenced
// by the Vite worker-url pattern from the manager but the module's
// surface at type-check time doesn't need to re-export them.
export type { StartMessage, StopMessage };
