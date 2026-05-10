/**
 * Single-cycle driver for the attachment-expiry worker. Factored out
 * of `./worker.ts` so the state machine is unit-testable without a
 * Web Worker runtime — the Worker entry point is a thin wrapper that
 * calls `runOneCycle` repeatedly until its AbortSignal trips.
 *
 * Simpler than reflection/summary: there's no per-row claim because
 * the `expire_old_attachments` RPC uses `for update skip locked`
 * internally. One cycle = one call to the RPC. If it returns >0, we
 * drain — another cycle fires immediately so the backlog clears in a
 * tight loop. If it returns 0, we nap for an hour.
 */
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import { createLogger } from '../../logger.svelte';

const log = createLogger('attachment-expiry-worker');

export type CycleResult =
  /** Just took the lease on this cycle — no work yet, caller should recurse immediately. */
  | 'acquired-lease'
  /** Someone else holds the lease; we're polling until it expires. */
  | 'polling'
  /** Lease held but no rows to expire — idle sleep before the next poll. */
  | 'empty-queue'
  /**
   * Expired some rows. More may remain, so the caller loops again
   * immediately (nap 0) to drain the backlog before napping.
   */
  | 'expired'
  /** Supabase errored during the cycle. Longer back-off. */
  | 'error';

export interface CycleContext {
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  /** Days of retention — attachments on threads quieter than this get nulled. */
  expiryDays: number;
  signal: AbortSignal;
  onLeaseLost: () => void;
}

export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'empty-queue';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) {
      // Polling fires every leasePollMs while another device holds
      // the lease. Logged at .debug so an idle worker doesn't spam
      // the drawer.
      log.debug('polling for lease (another device holds it)');
      return 'polling';
    }
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    log.info('lease acquired - starting expiry sweep');
    return 'acquired-lease';
  }

  let affected: number;
  try {
    affected = await ctx.supabase.expireOldAttachments(ctx.expiryDays);
  } catch (err) {
    // Transient failure — Supabase hiccup, network blip. Back off and
    // retry. The work isn't time-sensitive so we don't need tight
    // retries; the hourly idle poll will eventually catch up.
    log.info(
      `expire RPC failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  }
  if (affected === 0) {
    // Empty-queue is the steady state once the backlog drains.
    // .debug rather than .info to avoid an hourly heartbeat line in
    // the drawer; the user can flip log level to debug when actively
    // checking that the worker is alive.
    log.debug(`expire sweep found no rows older than ${ctx.expiryDays} days`);
    return 'empty-queue';
  }
  log.info(
    `expired ${affected} attachment row${affected === 1 ? '' : 's'} ` +
      `older than ${ctx.expiryDays} days`
  );
  return 'expired';
}

/** Tunables the outer loop maps cycle results to sleep durations with. */
export interface NapConfig {
  /** Sleep after 'polling' — we don't hold the lease. */
  leasePollMs: number;
  /** Sleep after 'empty-queue' — we hold the lease but nothing to do. */
  idleIntervalMs: number;
  /** Sleep after 'error' — Supabase transient failure. */
  errorBackoffMs: number;
}

export function napForResult(result: CycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
    case 'expired':
      // Drain: run another cycle with zero delay so a freshly-taken
      // lease can hit the RPC, and a non-zero expire result can keep
      // clearing backlog as fast as the server will let us.
      return 0;
    case 'polling':
      return config.leasePollMs;
    case 'empty-queue':
      return config.idleIntervalMs;
    case 'error':
      return config.errorBackoffMs;
  }
}
