/**
 * Background worker that reclaims binaries from old attachments.
 * Parallels `src/lib/agents/reflection/worker.ts` in shape — the
 * process work lives in `./loop.ts` and the cross-tab singleton
 * coordination lives in `./manager.ts`. This file is the message
 * boundary: construct clients from the `start` message, drive
 * `runOneCycle` until abort.
 *
 * Lifecycle:
 *
 *   start-msg ─► build clients ─► outer-loop: runOneCycle → sleep
 *   stop-msg  ─► abort signal ─► release lease ─► self.close()
 *
 * Unlike reflection/summary this worker doesn't need a VeniceClient
 * — expiration is a single Supabase RPC. The StartMessage is
 * correspondingly slimmer.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  holderId: string;
  expiryDays: number;
  batchLimit: number;
  leaseTtlSeconds: number;
  leaseHeartbeatMs: number;
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
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

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound): void {
  workerGlobal.postMessage(msg);
}

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
      message: `attachment-expiry worker setSession failed: ${sessionError.message}`,
    });
    return;
  }

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabaseAnonKey: msg.supabaseAnonKey },
    { client }
  );
  const coordinator = new LeaseCoordinator(supabase, 'attachment_expiry', msg.holderId, {
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
        supabase,
        coordinator,
        expiryDays: msg.expiryDays,
        signal,
        onLeaseLost: () => {
          post({
            type: 'log',
            level: 'warn',
            message: 'attachment-expiry lease lost — re-entering polling',
          });
        },
      };
      const result = await runOneCycle(ctx);
      const nap = napForResult(result, napConfig);
      if (nap > 0) await sleep(nap, signal);
    }
  } finally {
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
          message: `attachment-expiry worker loop crashed: ${err.message}`,
        });
      })
      .finally(() => {
        workerGlobal.close();
      });
  } else if (msg.type === 'stop') {
    controller.abort();
  }
});

export { sleep };
export type { StartMessage, StopMessage };
