/**
 * Journaling Web Worker entry point. Parallels
 * `../reflection/worker.ts`: build clients from the StartMessage,
 * instantiate the JournalAgent, drive `runOneCycle` until abort.
 *
 * Key differences from the reflection worker:
 *   - Lease partition is 'journal' (distinct from 'reflection',
 *     'embedding', etc.) so one device can hold both a reflection
 *     lease and a journal lease without contention.
 *   - Carries the user's journalTimezone through so the loop can
 *     compute today's date in that zone on every cycle.
 *   - Uses the balanced-tier model, not the fast tier.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { VeniceClient } from '../../venice';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
import { JournalAgent } from './agent';
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
  journalModel: string;
  /** IANA timezone or null (worker falls back to its own runtime zone). */
  timezone: string | null;
  /**
   * Free-form display name from Settings -> AI -> About you. Empty
   * string treated as "not set" by the prompt builder; passed through
   * verbatim otherwise. Both this and `userLocation` are forwarded
   * to the agent at spawn time and live-updated via a
   * {type:'profile'} postMessage so a Settings edit reaches the next
   * cycle without tearing the worker down.
   */
  userName: string;
  /** Same opt-in semantics as `userName`. */
  userLocation: string;
  holderId: string;
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

interface SessionMessage {
  type: 'session';
  accessToken: string;
  refreshToken: string;
}

interface TimezoneMessage {
  type: 'timezone';
  timezone: string | null;
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
  | TimezoneMessage
  | ProfileMessage;

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

let currentClient: SupabaseClient | null = null;
// Mutable holder for the current timezone so the main thread can
// update it mid-run without tearing the worker down. `runWorker`
// captures a reference to this object and reads through it on every
// cycle.
const tzHolder: { value: string | null } = { value: null };
// The agent built by `runWorker` is captured here so the message
// handler below can call `setUserProfile` on it when a profile-update
// message arrives. Cleared in the worker's `finally` so a stale
// pointer can't be dereferenced after the worker tore down.
let activeAgent: JournalAgent | null = null;

/**
 * Build the {name, location} pair the prompt builder expects from the
 * worker's two free-form fields. Returns null when both are empty so
 * the prompt's "About the user" block is fully suppressed for accounts
 * that haven't filled the form (zero tokens for the default case).
 */
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
      message: `journal worker setSession failed: ${sessionError.message}`,
    });
    return;
  }
  currentClient = client;
  tzHolder.value = msg.timezone;

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabaseAnonKey: msg.supabaseAnonKey },
    { client }
  );
  const venice = new VeniceClient({
    apiKey: msg.veniceApiKey,
    baseUrl: msg.veniceBaseUrl,
  });
  const coordinator = new LeaseCoordinator(supabase, 'journal', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  const agent = new JournalAgent(
    venice,
    supabase,
    msg.journalModel,
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
        timezone: tzHolder.value,
        threadClaimTtlSeconds: msg.threadClaimTtlSeconds,
        signal,
        onLeaseLost: () => {
          post({
            type: 'log',
            level: 'warn',
            message: 'journal lease lost - re-entering polling',
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
          message: `journal worker loop crashed: ${err.message}`,
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
  } else if (msg.type === 'timezone') {
    tzHolder.value = msg.timezone;
  } else if (msg.type === 'profile') {
    if (!activeAgent) return;
    activeAgent.setUserProfile(buildProfile(msg.userName, msg.userLocation));
  }
});

export { sleep };
export type { StartMessage, StopMessage };
