/**
 * Deep-sleep Web Worker entry point. Same structural pattern as the
 * wiki librarian's worker but with deep-sleep's loop. Shares the
 * `memory-librarian` lease partition with the rem worker so the two
 * librarians can't run concurrently per user across devices.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
import { DeepSleepAgent } from './agent';
import {
  runOneCycle,
  napForResult,
  type CycleContext,
  type NapConfig,
} from './loop';

interface StartMessage {
  type: 'start';
  supabaseUrl: string;
  supabasePublishableKey: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  deepSleepModel: string;
  holderId: string;
  minIntervalSeconds: number;
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
}

interface BusyOutbound {
  type: 'busy';
  busy: boolean;
}

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound | ProgressOutbound | BusyOutbound): void {
  workerGlobal.postMessage(msg);
}

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
  const client: SupabaseClient = createClient(msg.supabaseUrl, msg.supabasePublishableKey, {
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
      message: `deep-sleep setSession failed: ${sessionError.message}`,
    });
    return;
  }
  currentClient = client;

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabasePublishableKey: msg.supabasePublishableKey },
    { client }
  );
  const coordinator = new LeaseCoordinator(
    supabase,
    'memory-librarian',
    msg.holderId,
    {
      ttlSeconds: msg.leaseTtlSeconds,
      heartbeatMs: msg.leaseHeartbeatMs,
    }
  );

  const agent = new DeepSleepAgent(supabase, msg.deepSleepModel);

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
        minIntervalSeconds: msg.minIntervalSeconds,
        signal,
        onLeaseLost: () => {
          post({
            type: 'log',
            level: 'warn',
            message: 'deep-sleep lease lost - re-entering polling',
          });
        },
        onAgentStart: () => post({ type: 'busy', busy: true }),
        onAgentEnd: () => post({ type: 'busy', busy: false }),
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
          message: `deep-sleep loop crashed: ${err.message}`,
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
