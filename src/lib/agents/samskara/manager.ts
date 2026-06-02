/**
 * Main-thread supervisor for the samskara formation Web Worker.
 * Lifecycle plumbing (cross-tab lock, start / stop, log routing,
 * auth bridging, postStart-error cleanup) lives in
 * `BaseWorkerManager`; this file carries the samskara-specific
 * bits.
 *
 * Cross-tab singleton via
 * `navigator.locks.request('nak:samskara-worker')`. Runs
 * concurrently with the other agent workers via separate
 * `worker_kind` partitioning of the shared `worker_leases` table.
 *
 * Custom message handling here covers two channels the other
 * managers don't use:
 *
 *   - `mint`: bubbles a samskara birth out to a `window`
 *     CustomEvent that the toast component listens for. The toast
 *     is the only listener today, but decoupling via the bus means
 *     future surfaces (debug inspector, audio cue) can subscribe
 *     without touching this file.
 *   - `progress` (per-cycle phase advance): kept at trace level so
 *     users have to opt in via the Trace+ filter in the Logs
 *     drawer. Detailed per-phase decisions are emitted from
 *     loop.ts under the same source tag.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { notifySamskaraMint } from '../../samskara/events';
import {
  BaseWorkerManager,
  type BaseStartOpts,
} from '../base-manager';
import { createLogger } from '../../logger.svelte';

// Samskara is the one manager that needs to log at trace level
// from outside the base log-routing path (the per-cycle progress
// hook below). Keep a local logger so the trace message gets the
// right source tag without going through the base.
const traceLog = createLogger('samskara-worker');

/**
 * Match these with the worker's StartMessage. Drift across the
 * structured-clone boundary is invisible to TypeScript; keeping the
 * field names identical means grep finds both ends at once.
 *
 * Timing constants:
 *   - leaseTtlSeconds 300 / leaseHeartbeatMs 90_000: same shape as
 *     the other workers; two beats per expiry window.
 *   - claimTtlSeconds 600: generous (10 min). Each phase claims one
 *     row and may run an LLM call; the TTL must outlast the slowest
 *     realistic call with margin.
 *   - regenClaimTtlSeconds 180: three minutes. One LLM call to
 *     summarise; if it doesn't return inside that window the claim
 *     was probably orphaned by a tab close or process crash and
 *     another device should be free to retry rather than waiting
 *     out a 20-minute parking ticket. Earlier draft used 1200s for
 *     "generous, lower priority" reasoning; in practice a hung
 *     regen blocks the always-on summary update for everyone.
 *   - leasePollMs 20_000: match heartbeat cadence.
 *   - idleIntervalMs 300_000: when holding the lease and every
 *     phase said empty-phase, idle for a minute. Samskara work is
 *     much less time-critical than embeddings (the next chat-loop
 *     turn doesn't wait on it), so a longer idle is fine.
 *   - errorBackoffMs 15_000: somewhere between embeddings (5s) and
 *     reflection (10s). Errors here are usually transient Venice
 *     hiccups.
 *   - rateLimitBackoffMs 60_000: longer than embeddings (30s).
 *     Samskara has no UX urgency, so back off harder when Venice
 *     pushes back.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 300,
  leaseHeartbeatMs: 90_000,
  claimTtlSeconds: 600,
  regenClaimTtlSeconds: 180,
  leasePollMs: 20_000,
  idleIntervalMs: 300_000,
  errorBackoffMs: 15_000,
  rateLimitBackoffMs: 60_000,
};

class SamskaraManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:samskara-worker';
  protected readonly loggerSource = 'samskara-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-samskara',
    });
  }

  protected buildStartPayload(opts: BaseStartOpts, session: Session): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabasePublishableKey: opts.config.supabasePublishableKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      fastModel: agentModel('samskara').id,
      ...WORKER_DEFAULTS,
    };
  }

  protected onWorkerMessage(data: Record<string, unknown>): boolean {
    if (
      data.type === 'progress' &&
      typeof data.phase === 'string' &&
      typeof data.result === 'string'
    ) {
      // Per-cycle heartbeat. Fires on every phase advance, so it
      // would dominate the drawer at the default tier - kept at
      // trace so users have to opt in via the Trace+ filter to
      // see it.
      traceLog.trace(`cycle: ${data.phase} -> ${data.result}`);
      return true;
    }
    if (
      data.type === 'mint' &&
      (data.tier === 1 || data.tier === 2) &&
      typeof data.valence === 'number' &&
      typeof data.confidence === 'number'
    ) {
      // Bubble to the UI toast listener via a window CustomEvent.
      notifySamskaraMint({
        tier: data.tier,
        valence: data.valence,
        confidence: data.confidence,
      });
      return true;
    }
    return false;
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const samskaraManager = new SamskaraManager();
