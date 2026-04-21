/**
 * Background embeddings worker — the Web Worker entry point. The
 * process work is in `./loop.ts` (single-cycle state machine) and
 * `./lease.ts` (singleton-lease coordination); this file is just the
 * message-boundary wiring: construct clients from the `start` message,
 * build the source adapters, and drive `runOneCycle` in a loop until
 * abort.
 *
 * Lifecycle:
 *   start-msg ─► build clients ─► outer-loop: runOneCycle → sleep
 *                                              according to result
 *   stop-msg  ─► abort signal ─► release lease ─► self.close()
 *
 * Why a dedicated worker instead of a service worker: service workers
 * have an opinionated lifecycle (install/activate/fetch events; the
 * runtime is free to kill idle SWs) that fights a long-lived background
 * loop. A dedicated Worker lives exactly as long as we want it to —
 * until `stop` or the tab closes.
 *
 * Why the worker builds its own VeniceClient + SupabaseClient instead
 * of receiving them via postMessage: class instances don't
 * structured-clone. We send plain strings (API key, URL, tokens) and
 * reconstruct on this side; the main-thread instances live on
 * unaffected.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { VeniceClient } from '../venice';
import { SupabaseService } from '../supabase';
import type { EmbeddingSource } from './types';
import { createMemoriesSource } from './sources/memories';
import { createThreadsSource } from './sources/threads';
import { createSamskaraSubstrateSource } from './sources/samskara-substrate';
import { LeaseCoordinator } from './lease';
import {
  runOneCycle,
  napForResult,
  sleep,
  type CycleContext,
  type NapConfig,
} from './loop';

interface StartMessage {
  type: 'start';
  supabaseUrl: string;
  supabaseAnonKey: string;
  accessToken: string;
  refreshToken: string;
  veniceApiKey: string;
  veniceBaseUrl?: string;
  embeddingModel: string;
  holderId: string;
  /** Row-claim TTL, seconds. Longer than the lease TTL on purpose — see schema notes. */
  rowClaimTtlSeconds: number;
  /** Lease TTL, seconds. */
  leaseTtlSeconds: number;
  /** Heartbeat interval for the lease, milliseconds. Must be < leaseTtlSeconds*1000. */
  leaseHeartbeatMs: number;
  /** Poll interval while we don't hold the lease, milliseconds. */
  leasePollMs: number;
  /** Idle sleep when we hold the lease but the queue is empty, milliseconds. */
  idleIntervalMs: number;
  /** Short back-off after a transient Venice/Supabase error, milliseconds. */
  errorBackoffMs: number;
  /** Long back-off after a Venice 429, milliseconds. */
  rateLimitBackoffMs: number;
}

interface StopMessage {
  type: 'stop';
}

/**
 * Sent by the manager whenever the main-thread Supabase client rotates
 * its refresh token (onAuthStateChange fires with a fresh session).
 * The worker re-pins via setSession so all five Supabase clients in
 * the tab (main + this worker + three agent workers) share whichever
 * refresh token the main thread just minted. See the preamble comment
 * on runWorker for why autoRefreshToken is off on this side.
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
  source: string;
  /** Matches the `CycleResult` union in loop.ts; kept loose here to avoid a runtime dependency. */
  result: string;
}

// `self` in a dedicated worker is DedicatedWorkerGlobalScope, but with
// both DOM and WebWorker libs enabled in tsconfig TypeScript widens it.
// The cast gives us the worker-only members (postMessage, close)
// without needing /// <reference lib="webworker" /> on every file.
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

async function runWorker(msg: StartMessage, signal: AbortSignal): Promise<void> {
  // The worker's Supabase client is independent of the main thread's.
  // persistSession:false avoids fighting over localStorage, and
  // autoRefreshToken:false avoids racing the main thread for refresh-
  // token rotation. Supabase's "detect and revoke compromised refresh
  // tokens" flags any non-latest refresh token as replayed once the
  // reuse window (default 10s) elapses and revokes the whole session
  // family — with five independent clients per tab (main + this
  // worker + three agent workers) each scheduling their own
  // auto-refresh, that race fired regularly and logged the user out.
  // Single source of truth: the main thread refreshes, its manager
  // posts us a `session` message with the new tokens, and we re-pin
  // via setSession. See docs/dev/auth-session.md.
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
      message: `worker setSession failed: ${sessionError.message}`,
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
  // 'embedding' is this worker's partition of the shared `worker_leases`
  // table. Agent workers use different values ('reflection', …) and
  // hold independently.
  const coordinator = new LeaseCoordinator(supabase, 'embedding', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  const sources: EmbeddingSource[] = [
    createMemoriesSource(supabase),
    createThreadsSource(supabase),
    createSamskaraSubstrateSource(supabase),
  ];
  const napConfig: NapConfig = {
    leasePollMs: msg.leasePollMs,
    idleIntervalMs: msg.idleIntervalMs,
    errorBackoffMs: msg.errorBackoffMs,
    rateLimitBackoffMs: msg.rateLimitBackoffMs,
  };

  const onLeaseLost = (): void => {
    post({ type: 'log', level: 'warn', message: 'lease lost — re-entering polling' });
  };

  try {
    // Round-robin across sources: each outer iteration runs one cycle
    // per source before sleeping. A prior version of this file ran an
    // inner `while(!aborted)` per source, which had the unfortunate
    // property of starving every source after the first — memories
    // would drain forever and threads would never get a turn. Fair
    // scheduling matters the moment there's more than one source.
    //
    // Sleeping policy: if every source reported the same "nothing to
    // do" result (polling or empty-queue), we sleep for the longest
    // of their nap intervals. If any source made progress, we don't
    // sleep at all — drain. Lease acquisition is special-cased: it's
    // always zero-nap so we get straight to claiming a row.
    while (!signal.aborted) {
      let longestNap = 0;
      for (const source of sources) {
        if (signal.aborted) break;
        const ctx: CycleContext = {
          source,
          venice,
          coordinator,
          holderId: msg.holderId,
          embeddingModel: msg.embeddingModel,
          rowClaimTtlSeconds: msg.rowClaimTtlSeconds,
          signal,
          onLeaseLost,
        };
        const result = await runOneCycle(ctx);
        post({ type: 'progress', source: source.name, result });
        const nap = napForResult(result, napConfig);
        if (nap > longestNap) longestNap = nap;
      }
      if (longestNap > 0) await sleep(longestNap, signal);
    }
  } finally {
    // Unpublish before the release call — any late-arriving `session`
    // message after teardown should be a no-op, not a setSession
    // against a client whose loop has already exited.
    currentClient = null;
    // Graceful release — best-effort, swallows errors. The server-side
    // TTL would clean up anyway but releasing explicitly lets another
    // device take over instantly on a lock/sign-out.
    await coordinator.release();
  }
}

// The abort controller wires the `stop` message to the inner sleep/loop
// so a tab-close or explicit stop exits in milliseconds instead of
// waiting out an idle tick.
const controller = new AbortController();

workerGlobal.addEventListener('message', (evt: MessageEvent<InboundMessage>) => {
  const msg = evt.data;
  if (msg.type === 'start') {
    runWorker(msg, controller.signal)
      .catch((err: Error) => {
        post({ type: 'log', level: 'error', message: `worker loop crashed: ${err.message}` });
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
