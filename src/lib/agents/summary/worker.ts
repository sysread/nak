/**
 * Background summary worker — the Web Worker entry point. Parallels
 * `../reflection/worker.ts` in shape; the process work lives in
 * `./loop.ts` and the cross-tab singleton coordination lives in the
 * manager. This file is the message boundary: construct clients,
 * instantiate the SummaryAgent, and drive `runOneCycle` until abort.
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
import { VENICE_SUMMARY_MODEL } from '../../models';
import { SummaryAgent } from './agent';
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
  summaryModel: string;
  holderId: string;
  /** Per-thread claim TTL, seconds. Summaries are a single Venice call; 120s is generous. */
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

type InboundMessage = StartMessage | StopMessage;

interface LogOutbound {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface ProgressOutbound {
  type: 'progress';
  result: string;
  threadId?: string;
}

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound | ProgressOutbound): void {
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
      message: `summary worker setSession failed: ${sessionError.message}`,
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
  const coordinator = new LeaseCoordinator(supabase, 'summary', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  const agent = new SummaryAgent(venice, supabase, msg.summaryModel);

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
          post({
            type: 'log',
            level: 'warn',
            message: 'summary lease lost — re-entering polling',
          });
        },
      };
      const result = await runOneCycle(ctx);
      post({ type: 'progress', result });
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
          message: `summary worker loop crashed: ${err.message}`,
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
export { VENICE_SUMMARY_MODEL };
