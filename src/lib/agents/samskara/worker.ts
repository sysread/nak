/**
 * Samskara formation worker — the Web Worker entry point. The cycle
 * driver lives in `./loop.ts` (testable state machine across phases)
 * and the cross-tab singleton coordination lives in `./manager.ts`.
 * This file is the message boundary: build clients from the `start`
 * message, instantiate the SamskaraAgent, and round-robin
 * `runOneCycle` across all phases until abort.
 *
 * Outer-loop structure mirrors the embeddings worker but with phase
 * rotation: each cycle advances one phase from the PHASES array; an
 * entire pass through PHASES with all empty-phase results triggers
 * the long idle nap.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { VeniceClient } from '../../venice';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
import { SamskaraAgent } from './agent';
import {
  runOneCycle,
  napForResult,
  PHASES,
  type CycleContext,
  type NapConfig,
  type SamskaraPhase,
} from './loop';

/**
 * How often the exploratory phases (mint-tier1, pair-relate) are
 * allowed to fire. Both look at the recent substrate and call an
 * LLM agent against it; without a throttle they fire every
 * rotation forever (mint-tier1's dedup-reinforce branch always
 * returns 'progress' when there's any existing substrate to
 * match, pinning the outer worker's idle nap off).
 *
 * Sixty seconds gives the worker a chance to keep up with bursts
 * of new substrate (assimilate writes new rows) while ensuring
 * the steady-state idle case rotates at roughly 1/minute instead
 * of 1/9-seconds. Tighter would re-spam; looser would leave new
 * substrate unminted longer than feels responsive in the toast
 * stream.
 */
const PHASE_THROTTLE_MIN_INTERVAL_MS = 60 * 1000;

interface StartMessage {
  type: 'start';
  supabaseUrl: string;
  supabaseAnonKey: string;
  accessToken: string;
  refreshToken: string;
  veniceApiKey: string;
  veniceBaseUrl?: string;
  fastModel: string;
  holderId: string;
  /** Lease TTL, seconds. */
  leaseTtlSeconds: number;
  /** Heartbeat interval, ms. Must be < leaseTtlSeconds*1000. */
  leaseHeartbeatMs: number;
  /** Per-row claim TTL for assimilator/embed phases, seconds. */
  claimTtlSeconds: number;
  /** Compound-regen claim TTL, seconds — generous, one LLM call per regen. */
  regenClaimTtlSeconds: number;
  /** Poll interval while we don't hold the lease, ms. */
  leasePollMs: number;
  /** Idle sleep after a full empty rotation, ms. */
  idleIntervalMs: number;
  /** Short back-off after a transient error, ms. */
  errorBackoffMs: number;
  /** Long back-off after a Venice 429, ms. */
  rateLimitBackoffMs: number;
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
  phase: string;
  result: string;
}

interface MintOutbound {
  type: 'mint';
  tier: 1 | 2;
  /** Continuous [-1, 1]. Main-thread toast renders emoji per band. */
  valence: number;
  /** Minter confidence in [0, 1]. Drives the second axis of the mood
   *  pill (tentative vs confident column in MOOD_TABLE). */
  confidence: number;
}

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound | ProgressOutbound | MintOutbound): void {
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
  const client: SupabaseClient = createClient(msg.supabaseUrl, msg.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  post({ type: 'log', level: 'info', message: 'worker: setSession starting' });
  const { error: sessionError } = await client.auth.setSession({
    access_token: msg.accessToken,
    refresh_token: msg.refreshToken,
  });
  if (sessionError) {
    post({
      type: 'log',
      level: 'error',
      message: `samskara worker setSession failed: ${sessionError.message}`,
    });
    return;
  }
  currentClient = client;
  // Routine lifecycle breadcrumb - emitted on every worker start, so it
  // would clutter the default Info+ view without telling the user
  // anything actionable. Kept at debug for the Debug+ tier.
  post({ type: 'log', level: 'debug', message: 'worker: setSession ok, entering main loop' });

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabaseAnonKey: msg.supabaseAnonKey },
    { client }
  );
  const venice = new VeniceClient({
    apiKey: msg.veniceApiKey,
    baseUrl: msg.veniceBaseUrl,
  });
  // Separate worker_kind so this lease holds independently of the
  // embedding/reflection/summary leases. Each worker is one row in
  // the worker_leases table.
  const coordinator = new LeaseCoordinator(supabase, 'samskara', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  const agent = new SamskaraAgent(venice, msg.fastModel);

  // Per-phase throttle state. Lives for the worker process
  // lifetime so successive rotations of the outer loop see the
  // same map. Lease loss clears the map so a recovered device
  // re-explores once - another holder may have written substrate
  // we never saw while we were leaseless.
  const phaseThrottle: {
    lastRunMs: Map<SamskaraPhase, number>;
    minIntervalMs: number;
  } = {
    lastRunMs: new Map(),
    minIntervalMs: PHASE_THROTTLE_MIN_INTERVAL_MS,
  };

  const napConfig: NapConfig = {
    leasePollMs: msg.leasePollMs,
    idleIntervalMs: msg.idleIntervalMs,
    errorBackoffMs: msg.errorBackoffMs,
    rateLimitBackoffMs: msg.rateLimitBackoffMs,
  };

  const onLeaseLost = (): void => {
    post({
      type: 'log',
      level: 'warn',
      message: 'samskara lease lost - re-entering polling',
    });
    // Clear the throttle so a recovered device re-explores once.
    // Another holder may have written substrate (assimilate
    // writes, agent mints) we never saw while we were leaseless;
    // our cached "I just looked at the substrate" stamps are
    // therefore stale.
    phaseThrottle.lastRunMs.clear();
  };

  try {
    while (!signal.aborted) {
      // Phase rotation. Each iteration of this inner loop is one
      // cycle = one phase advanced. After running every phase, we
      // either drained to empty-phase across the whole pass (idle
      // sleep) or made progress somewhere (skip the nap and keep
      // draining).
      let allEmpty = true;
      let longestNap = 0;
      for (const phase of PHASES) {
        if (signal.aborted) break;
        const ctx: CycleContext = {
          agent,
          supabase,
          venice,
          coordinator,
          holderId: msg.holderId,
          claimTtlSeconds: msg.claimTtlSeconds,
          regenClaimTtlSeconds: msg.regenClaimTtlSeconds,
          phase,
          signal,
          onLeaseLost,
          onMint: (info) =>
            post({
              type: 'mint',
              tier: info.tier,
              valence: info.valence,
              confidence: info.confidence,
            }),
          phaseThrottle,
        };
        const result = await runOneCycle(ctx);
        post({ type: 'progress', phase, result });
        if (result !== 'empty-phase' && result !== 'polling') allEmpty = false;
        // Short-circuit: if we lost the lease or are polling for it,
        // bail out of phase rotation early — the next outer loop
        // iteration will re-acquire and start over.
        if (result === 'polling' || result === 'acquired-lease') {
          allEmpty = false;
          longestNap = Math.max(longestNap, napForResult(result, napConfig));
          break;
        }
        const nap = napForResult(result, napConfig);
        if (nap > longestNap) longestNap = nap;
      }
      if (allEmpty) {
        await sleep(napConfig.idleIntervalMs, signal);
      } else if (longestNap > 0) {
        await sleep(longestNap, signal);
      }
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
          message: `samskara worker loop crashed: ${err.message}`,
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
          message: `samskara forwarded setSession failed: ${err.message}`,
        });
      });
  }
});

export { sleep };
export type { StartMessage, StopMessage };
