/**
 * Bias-observer worker - Web Worker entry point. The cycle driver
 * lives in `./loop.ts` (testable state machine across phases) and
 * the cross-tab singleton coordination lives in `./manager.ts`.
 * This file is the message boundary: build clients from the `start`
 * message, instantiate the observer agent, and round-robin
 * `runOneCycle` across PHASES until abort.
 *
 * Two postMessage channels inbound:
 *
 *   - `start` / `stop` / `session`: same shape as samskara's
 *     worker. Session forward is how the manager hands rotated
 *     access tokens through without restarting the worker.
 *
 *   - `active-conv-ids`: the main thread's running set of
 *     conversation ids the user has open in this tab/device. The
 *     worker excludes these from analysis (a still-active
 *     conversation might pick up a new user message any second; no
 *     point analyzing it). Empty set is fine and means "analyze
 *     whatever you find."
 *
 * Outbound channels:
 *
 *   - `log` / `progress`: the standard worker breadcrumb shape the
 *     base manager routes into the logs drawer.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../../supabase';
import { LeaseCoordinator } from '../../embeddings/lease';
import { BiasObserverAgent } from './agent';
import {
  runOneCycle,
  napForResult,
  PHASES,
  type CycleContext,
  type NapConfig,
} from './loop';

interface StartMessage {
  type: 'start';
  supabaseUrl: string;
  supabasePublishableKey: string;
  accessToken: string;
  refreshToken: string;
  fastModel: string;
  holderId: string;
  /** Initial active-conv set; updates land via `active-conv-ids`. */
  activeConvIds: string[];
  leaseTtlSeconds: number;
  leaseHeartbeatMs: number;
  claimTtlSeconds: number;
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
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

interface ActiveConvIdsMessage {
  type: 'active-conv-ids';
  ids: string[];
}

type InboundMessage = StartMessage | StopMessage | SessionMessage | ActiveConvIdsMessage;

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

const workerGlobal = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: LogOutbound | ProgressOutbound): void {
  workerGlobal.postMessage(msg);
}

let currentClient: SupabaseClient | null = null;

/**
 * Mutable set of active conversation ids. Re-read on every cycle
 * (via a getter on CycleContext), so a postMessage update from the
 * manager takes effect on the next phase boundary.
 */
const activeConvIds = new Set<string>();

/**
 * Cross-rotation gate for the aggregate phase. Seeded `true` so
 * the first rotation after worker start (or after re-acquiring
 * the lease) is eligible to refill the bias_summary cache;
 * thereafter analyze sets `value=true` on every successful save
 * and aggregate clears it. Without this gate the aggregate phase
 * spun N_catalog * 3 RPCs per rotation with no idle nap - see
 * `loop.ts` for the full failure mode.
 */
const aggregateDirty = { value: true };

/**
 * How often the aggregate phase is allowed to run, at most. Five
 * minutes coalesces backlog processing (each analyze save flips
 * `aggregateDirty`, which without this throttle would trigger a
 * fresh N_catalog * 3 pass per save) and also caps the
 * fresh-page-load probe: the cache only counts as "fresh enough
 * to adopt without recomputing" if it's within this window.
 *
 * Five minutes is well inside what the chat-loop tolerates -
 * `bias_summary` is consumed as a smoothed posterior tendency
 * block in the system prompt, so cache staleness up to a few
 * minutes is invisible to the LLM consumer. Tighter (e.g. 60s)
 * would refresh more often but also re-spam more aggressively on
 * backlog burndown; looser (e.g. 30m) would suppress refreshes
 * even when genuinely warranted.
 */
const AGGREGATE_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Cross-rotation throttle state for the aggregate phase.
 * `lastRunMs === 0` marks bootstrap - the next aggregate attempt
 * probes the shared cache once and either adopts it or runs a
 * full pass. A non-zero value is the timestamp of the most
 * recent aggregate (or adopted cache age) and gates subsequent
 * rotations within `minIntervalMs`. Reset to 0 on lease loss so
 * a recovered device re-probes the shared cache, since another
 * device may have written observations during our gap.
 */
const aggregateThrottle = {
  lastRunMs: 0,
  minIntervalMs: AGGREGATE_MIN_INTERVAL_MS,
};

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
  for (const id of msg.activeConvIds) activeConvIds.add(id);

  const client: SupabaseClient = createClient(msg.supabaseUrl, msg.supabasePublishableKey, {
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
      message: `bias worker setSession failed: ${sessionError.message}`,
    });
    return;
  }
  currentClient = client;
  post({ type: 'log', level: 'debug', message: 'worker: setSession ok, entering main loop' });

  const supabase = new SupabaseService(
    { supabaseUrl: msg.supabaseUrl, supabasePublishableKey: msg.supabasePublishableKey },
    { client }
  );
  const coordinator = new LeaseCoordinator(supabase, 'bias', msg.holderId, {
    ttlSeconds: msg.leaseTtlSeconds,
    heartbeatMs: msg.leaseHeartbeatMs,
  });

  const agent = new BiasObserverAgent(supabase, msg.fastModel);

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
      message: 'bias lease lost - re-entering polling',
    });
    // Re-flag the cache as dirty AND reset the throttle so the
    // next acquire-and-rotate pass re-probes the shared cache.
    // While we were leaseless the device that took over may
    // have written observations we never saw; our previous
    // "clean" stance and our last-run timestamp are both stale.
    aggregateDirty.value = true;
    aggregateThrottle.lastRunMs = 0;
  };

  try {
    while (!signal.aborted) {
      let allEmpty = true;
      let longestNap = 0;
      for (const phase of PHASES) {
        if (signal.aborted) break;
        const ctx: CycleContext = {
          agent,
          supabase,
          coordinator,
          holderId: msg.holderId,
          claimTtlSeconds: msg.claimTtlSeconds,
          phase,
          signal,
          onLeaseLost,
          excludeThreadIds: () => Array.from(activeConvIds),
          aggregateDirty,
          aggregateThrottle,
        };
        const result = await runOneCycle(ctx);
        post({ type: 'progress', phase, result });
        if (result !== 'empty-phase' && result !== 'polling') allEmpty = false;
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
          message: `bias worker loop crashed: ${err.message}`,
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
          message: `bias forwarded setSession failed: ${err.message}`,
        });
      });
  } else if (msg.type === 'active-conv-ids') {
    activeConvIds.clear();
    for (const id of msg.ids) activeConvIds.add(id);
  }
});

export { sleep };
export type { StartMessage, StopMessage, ActiveConvIdsMessage };
