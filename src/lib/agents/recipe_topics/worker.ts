/**
 * Background recipe-topics worker - the Web Worker entry point.
 * Parallels `../memory_topics/worker.ts` in shape; the cycle work
 * lives in `./loop.ts` and the cross-tab singleton coordination
 * lives in the manager.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { VeniceClient } from '../../venice';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
import { RecipeTopicsAgent } from './agent';
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
  recipeTopicsModel: string;
  holderId: string;
  /** Per-recipe claim TTL, seconds. One non-streaming Venice call; 60s is comfortable margin. */
  recipeClaimTtlSeconds: number;
  leaseTtlSeconds: number;
  leaseHeartbeatMs: number;
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
}

interface StopMessage {
  type: 'stop';
}

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
  result: string;
  recipeId?: string;
}

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound | ProgressOutbound): void {
  workerGlobal.postMessage(msg);
}

// See `../reflection/worker.ts` for the rationale. Published by
// runWorker after the initial setSession so the 'session' handler can
// forward rotated tokens; cleared on teardown.
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
  // autoRefreshToken:false - see `../reflection/worker.ts` and
  // `../../embeddings/worker.ts` for the full story. Main thread is
  // the sole refresher; rotated tokens reach us via 'session'.
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
      message: `recipe-topics worker setSession failed: ${sessionError.message}`,
    });
    return;
  }
  currentClient = client;

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabaseAnonKey: msg.supabaseAnonKey },
    { client }
  );
  const venice = new VeniceClient({
    apiKey: msg.veniceApiKey,
    baseUrl: msg.veniceBaseUrl,
  });
  const coordinator = new LeaseCoordinator(
    supabase,
    'recipe-topics',
    msg.holderId,
    {
      ttlSeconds: msg.leaseTtlSeconds,
      heartbeatMs: msg.leaseHeartbeatMs,
    }
  );

  const agent = new RecipeTopicsAgent(venice, supabase, msg.recipeTopicsModel);

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
        recipeClaimTtlSeconds: msg.recipeClaimTtlSeconds,
        signal,
        onLeaseLost: () => {
          post({
            type: 'log',
            level: 'warn',
            message: 'recipe-topics lease lost - re-entering polling',
          });
        },
      };
      const result = await runOneCycle(ctx);
      post({ type: 'progress', result });
      const nap = napForResult(result, napConfig);
      if (nap > 0) await sleep(nap, signal);
    }
  } finally {
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
          message: `recipe-topics worker loop crashed: ${err.message}`,
        });
      })
      .finally(() => {
        workerGlobal.close();
      });
  } else if (msg.type === 'stop') {
    controller.abort();
  } else if (msg.type === 'session') {
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
