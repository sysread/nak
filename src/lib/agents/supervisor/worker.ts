/**
 * Supervisor worker - the Web Worker entry point for the consolidated
 * background fleet. The rotation driver lives in `./loop.ts` (testable
 * state machine) and cross-tab singleton coordination lives in the
 * manager. This file is the message boundary: construct ONE Supabase
 * client + ONE Venice client + ONE LeaseCoordinator, instantiate the
 * five agents the seven work units need, and drive `runOneCycle`
 * until abort.
 *
 * See `./loop.ts` for the rationale on why the supervisor exists at
 * all (heartbeat / auth amortisation across the formerly-separate
 * per-feature workers) and which features it consolidates (the seven
 * simple claim-based ones; embeddings / bias / samskara / wiki /
 * wiki-librarian remain standalone).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { VeniceClient } from '../../venice';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
import { ReflectionAgent } from '../reflection/agent';
import { SummaryAgent } from '../summary/agent';
import { TopicsAgent } from '../topics/agent';
import { MemoryTopicsAgent } from '../memory_topics/agent';
import { RecipeTopicsAgent } from '../recipe_topics/agent';
import {
  runOneCycle,
  napForResult,
  type SupervisorContext,
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
  summaryModel: string;
  topicsModel: string;
  memoryTopicsModel: string;
  recipeTopicsModel: string;
  holderId: string;
  /** Per-thread claim TTL for the claim-based units (seconds). */
  threadClaimTtlSeconds: number;
  /** Attachment retention window, days. */
  attachmentExpiryDays: number;
  /** Supervisor lease TTL (seconds). */
  leaseTtlSeconds: number;
  /** Supervisor lease heartbeat (ms). Must be < leaseTtlSeconds*1000. */
  leaseHeartbeatMs: number;
  /** Sleep when supervisor doesn't hold the lease yet (ms). */
  leasePollMs: number;
  /** Sleep when every unit reported empty-phase (ms). */
  idleIntervalMs: number;
  /** Sleep on transient error (ms). */
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
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

interface ProgressOutbound {
  type: 'progress';
  result: string;
}

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound | ProgressOutbound): void {
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
  // autoRefreshToken:false: only the main thread refreshes; rotated
  // tokens arrive here via 'session' messages. Same rationale as the
  // standalone workers - multiple clients racing to refresh trips
  // Supabase's replay-detection and revokes the session.
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
      message: `supervisor setSession failed: ${sessionError.message}`,
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
  const coordinator = new LeaseCoordinator(supabase, 'supervisor', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  // Five agents instantiated once for the worker's lifetime. The
  // sixth and seventh units (auto_title, attachment_expiry) don't
  // need agents - title-gen uses the bare Venice client; attachment
  // expiry is a pure SQL RPC.
  //
  // Each agent's model id comes from the start payload (resolved
  // from AGENT_MODELS on the main thread) so a model swap in the
  // registry takes effect on the next worker start without
  // requiring a code change here.
  const reflection = new ReflectionAgent(venice, supabase, msg.reflectionModel);
  const summary = new SummaryAgent(venice, supabase, msg.summaryModel);
  const topics = new TopicsAgent(venice, supabase, msg.topicsModel);
  const memoryTopics = new MemoryTopicsAgent(venice, supabase, msg.memoryTopicsModel);
  const recipeTopics = new RecipeTopicsAgent(venice, supabase, msg.recipeTopicsModel);

  const napConfig: NapConfig = {
    leasePollMs: msg.leasePollMs,
    idleIntervalMs: msg.idleIntervalMs,
    errorBackoffMs: msg.errorBackoffMs,
  };

  const onLeaseLost = (): void => {
    post({
      type: 'log',
      level: 'warn',
      message: 'supervisor lease lost - re-entering polling',
    });
  };

  try {
    while (!signal.aborted) {
      const ctx: SupervisorContext = {
        supabase,
        venice,
        coordinator,
        holderId: msg.holderId,
        userId: msg.userId,
        signal,
        onLeaseLost,
        agents: { reflection, summary, topics, memoryTopics, recipeTopics },
        tunables: {
          threadClaimTtlSeconds: msg.threadClaimTtlSeconds,
          attachmentExpiryDays: msg.attachmentExpiryDays,
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
          message: `supervisor loop crashed: ${err.message}`,
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
          message: `supervisor forwarded setSession failed: ${err.message}`,
        });
      });
  }
});

export { sleep };
export type { StartMessage, StopMessage };
