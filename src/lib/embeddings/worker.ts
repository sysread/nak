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

type InboundMessage = StartMessage | StopMessage;

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

async function runWorker(msg: StartMessage, signal: AbortSignal): Promise<void> {
  // The worker's Supabase client is independent of the main thread's.
  // persistSession:false avoids fighting over localStorage; we pin the
  // session explicitly via setSession and let autoRefreshToken keep the
  // access token live if the worker outlives its original token.
  const client: SupabaseClient = createClient(msg.supabaseUrl, msg.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
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

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabaseAnonKey: msg.supabaseAnonKey },
    { client }
  );
  const venice = new VeniceClient({
    apiKey: msg.veniceApiKey,
    baseUrl: msg.veniceBaseUrl,
  });
  const coordinator = new LeaseCoordinator(supabase, msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  const sources: EmbeddingSource[] = [createMemoriesSource(supabase)];
  const napConfig: NapConfig = {
    leasePollMs: msg.leasePollMs,
    idleIntervalMs: msg.idleIntervalMs,
    errorBackoffMs: msg.errorBackoffMs,
    rateLimitBackoffMs: msg.rateLimitBackoffMs,
  };

  try {
    // Drive every registered source through the same cycle loop. Today
    // there's only `memories` — but the outer for-of is the shape a
    // future conversation-summary source slots into without touching
    // this file.
    for (const source of sources) {
      while (!signal.aborted) {
        const ctx: CycleContext = {
          source,
          venice,
          coordinator,
          holderId: msg.holderId,
          embeddingModel: msg.embeddingModel,
          rowClaimTtlSeconds: msg.rowClaimTtlSeconds,
          signal,
          onLeaseLost: () => {
            // Next cycle's top check sees isHolding===false and falls
            // into the polling branch; no special wake-up needed.
            post({
              type: 'log',
              level: 'warn',
              message: 'lease lost — re-entering polling',
            });
          },
        };
        const result = await runOneCycle(ctx);
        post({ type: 'progress', source: source.name, result });
        const nap = napForResult(result, napConfig);
        if (nap > 0) await sleep(nap, signal);
      }
      if (signal.aborted) break;
    }
  } finally {
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
  }
});
