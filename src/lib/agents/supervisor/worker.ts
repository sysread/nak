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
  supabasePublishableKey: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  reflectionModel: string;
  summaryModel: string;
  topicsModel: string;
  memoryTopicsModel: string;
  recipeTopicsModel: string;
  holderId: string;
  /** Per-thread claim TTL for the claim-based units (seconds). */
  threadClaimTtlSeconds: number;
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
  /**
   * User's display timezone (IANA) - threaded into the reflection
   * unit's day-gate. Live-updateable via the 'timezone' inbound
   * message; null falls back to UTC server-side. See
   * src/lib/agents/wiki/worker.ts for the matching pattern.
   */
  timezone: string | null;
}

interface StopMessage {
  type: 'stop';
}

interface SessionMessage {
  type: 'session';
  accessToken: string;
  refreshToken: string;
}

interface TimezoneMessage {
  type: 'timezone';
  timezone: string | null;
}

type InboundMessage = StartMessage | StopMessage | SessionMessage | TimezoneMessage;

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

// Holder cell so a 'timezone' postMessage updates the value the
// next cycle's SupervisorContext reads. Same shape as the wiki
// worker's tzHolder. Initialised to null inside runWorker so a
// pre-start 'timezone' message doesn't matter (the start message
// also carries timezone and overwrites).
const tzHolder: { value: string | null } = { value: null };

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
      message: `supervisor setSession failed: ${sessionError.message}`,
    });
    return;
  }
  currentClient = client;
  tzHolder.value = msg.timezone;

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabasePublishableKey: msg.supabasePublishableKey },
    { client }
  );
  const coordinator = new LeaseCoordinator(supabase, 'supervisor', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  // Five agents instantiated once for the worker's lifetime. The
  // sixth unit (auto_title) needs no agent - title-gen drives
  // SupabaseService.complete directly.
  //
  // Each agent's model id comes from the start payload (resolved
  // from AGENT_MODELS on the main thread) so a model swap in the
  // registry takes effect on the next worker start without
  // requiring a code change here.
  const reflection = new ReflectionAgent(supabase, msg.reflectionModel);
  const summary = new SummaryAgent(supabase, msg.summaryModel);
  const topics = new TopicsAgent(supabase, msg.topicsModel);
  const memoryTopics = new MemoryTopicsAgent(supabase, msg.memoryTopicsModel);
  const recipeTopics = new RecipeTopicsAgent(supabase, msg.recipeTopicsModel);

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
        coordinator,
        holderId: msg.holderId,
        userId: msg.userId,
        timezone: tzHolder,
        signal,
        onLeaseLost,
        agents: { reflection, summary, topics, memoryTopics, recipeTopics },
        tunables: {
          threadClaimTtlSeconds: msg.threadClaimTtlSeconds,
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
  } else if (msg.type === 'timezone') {
    tzHolder.value = msg.timezone;
  }
});

export { sleep };
export type { StartMessage, StopMessage };
