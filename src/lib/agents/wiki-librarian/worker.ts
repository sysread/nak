/**
 * Wiki librarian Web Worker entry point. Same shape as the per-
 * conversation wiki worker but runs on a much longer cadence and
 * has no per-thread queue.
 *
 *   - Lease partition is `'wiki-librarian'` (distinct from `'wiki'`,
 *     `'reflection'`, etc.) so the librarian can run alongside the
 *     other workers without contention.
 *   - The loop's `minIntervalSeconds` defaults to 12h; the idle
 *     nap defaults to 1h so a device that woke up too-soon checks
 *     again hourly without spamming the claim RPC.
 *   - No timezone parameter: the librarian's eligibility predicate
 *     is "has it been long enough since the last run", not "what
 *     calendar day are we in".
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { VeniceClient } from '../../venice';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
import { WikiLibrarianAgent } from './agent';
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
  wikiLibrarianModel: string;
  holderId: string;
  /** Min seconds between successive librarian runs (across devices). */
  minIntervalSeconds: number;
  /**
   * User profile from Settings -> AI -> About you. Empty strings
   * are the "not set" sentinels; the agent's prompt builder
   * suppresses the block when both are empty. Live-updated via
   * the `profile` inbound message.
   */
  userName: string;
  userLocation: string;
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

interface ProfileMessage {
  type: 'profile';
  userName: string;
  userLocation: string;
}

type InboundMessage =
  | StartMessage
  | StopMessage
  | SessionMessage
  | ProfileMessage;

interface LogOutbound {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface ProgressOutbound {
  type: 'progress';
  result: string;
}

/**
 * Brackets the actual `agent.run()` invocation - emitted at the top of
 * the agent call and again when it returns (success or failure). The
 * main-thread manager turns these into a `wikiLibrarianRunner.workerBusy`
 * boolean that the Wiki top-bar reads to disable the manual-run button
 * while a scheduled run is in flight. Distinct from the cycle-end
 * `progress` event because the cycle-end fires even on cheap outcomes
 * (polling, too-soon) that don't need to gray out the button.
 */
interface BusyOutbound {
  type: 'busy';
  busy: boolean;
}

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound | ProgressOutbound | BusyOutbound): void {
  workerGlobal.postMessage(msg);
}

let currentClient: SupabaseClient | null = null;
let activeAgent: WikiLibrarianAgent | null = null;

function buildProfile(
  name: string,
  location: string
): { name: string | null; location: string | null } | null {
  const n = name.trim();
  const l = location.trim();
  if (n.length === 0 && l.length === 0) return null;
  return {
    name: n.length > 0 ? n : null,
    location: l.length > 0 ? l : null,
  };
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
      message: `wiki librarian setSession failed: ${sessionError.message}`,
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
    'wiki-librarian',
    msg.holderId,
    {
      ttlSeconds: msg.leaseTtlSeconds,
      heartbeatMs: msg.leaseHeartbeatMs,
    }
  );

  const agent = new WikiLibrarianAgent(
    venice,
    supabase,
    msg.wikiLibrarianModel,
    buildProfile(msg.userName, msg.userLocation)
  );
  activeAgent = agent;

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
            message: 'wiki librarian lease lost - re-entering polling',
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
    activeAgent = null;
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
          message: `wiki librarian loop crashed: ${err.message}`,
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
  } else if (msg.type === 'profile') {
    if (!activeAgent) return;
    activeAgent.setUserProfile(buildProfile(msg.userName, msg.userLocation));
  }
});

export { sleep };
export type { StartMessage, StopMessage };
