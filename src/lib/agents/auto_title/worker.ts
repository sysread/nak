/**
 * Background auto-title worker - the Web Worker entry point. Parallels
 * `../summary/worker.ts` in shape; the process work lives in `./loop.ts`
 * and the cross-tab singleton coordination lives in the manager. This
 * file is the message boundary: construct clients, drive `runOneCycle`
 * until abort.
 *
 * See `../reflection/worker.ts` for the full rationale on dedicated
 * workers, why we build clients on this side of the boundary
 * (structured-clone limits on class instances), and the lifecycle
 * shape.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { VeniceClient } from '../../venice';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
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
  veniceApiKey: string;
  veniceBaseUrl?: string;
  holderId: string;
  /** Per-thread claim TTL, seconds. One non-streaming Venice call; 60s is generous. */
  threadClaimTtlSeconds: number;
  leaseTtlSeconds: number;
  leaseHeartbeatMs: number;
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
}

interface StopMessage {
  type: 'stop';
}

/**
 * Sent by the manager on main-thread refresh-token rotation. We
 * re-pin via setSession so all the per-tab Supabase clients share
 * whichever token the main thread just minted. See runWorker's
 * preamble.
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

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound): void {
  workerGlobal.postMessage(msg);
}

// See `../reflection/worker.ts` for the full rationale. Published
// by runWorker after the initial setSession so the 'session' handler
// can forward rotated tokens; cleared on teardown.
let currentClient: SupabaseClient | null = null;

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
  // autoRefreshToken:false because multiple clients per tab racing to
  // rotate the refresh token tripped Supabase's replay detection and
  // revoked the session. See `../reflection/worker.ts` and
  // `../../embeddings/worker.ts` for the full story. Main thread is
  // the sole refresher; the manager forwards new tokens via a
  // `session` message and we re-pin via setSession.
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
      message: `auto-title worker setSession failed: ${sessionError.message}`,
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
  const coordinator = new LeaseCoordinator(supabase, 'auto_title', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  const napConfig: NapConfig = {
    leasePollMs: msg.leasePollMs,
    idleIntervalMs: msg.idleIntervalMs,
    errorBackoffMs: msg.errorBackoffMs,
  };

  try {
    while (!signal.aborted) {
      const ctx: CycleContext = {
        venice,
        supabase,
        coordinator,
        holderId: msg.holderId,
        threadClaimTtlSeconds: msg.threadClaimTtlSeconds,
        signal,
        onLeaseLost: () => {
          post({
            type: 'log',
            level: 'warn',
            message: 'auto-title lease lost - re-entering polling',
          });
        },
      };
      const result = await runOneCycle(ctx);
      const nap = napForResult(result, napConfig);
      if (nap > 0) await sleep(nap, signal);
    }
  } finally {
    // Unpublish before release so a late-arriving `session` message
    // is a no-op rather than a setSession on a dead loop.
    currentClient = null;
    await coordinator.release();
  }
}

const controller = new AbortController();

workerGlobal.addEventListener('message', (evt: MessageEvent<InboundMessage>) => {
  const msg = evt.data;
  if (msg.type === 'start') {
    runWorker(msg, controller.signal)
      .catch((err: Error) => {
        post({
          type: 'log',
          level: 'error',
          message: `auto-title worker loop crashed: ${err.message}`,
        });
      })
      .finally(() => {
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

export { sleep };
export type { StartMessage, StopMessage };
