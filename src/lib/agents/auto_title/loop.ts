/**
 * Single-cycle driver for the auto-title worker. Factored out of
 * `./worker.ts` so the state machine is unit-testable without a Web
 * Worker runtime. Shape mirrors `../summary/loop.ts` deliberately -
 * both workers share the lease-acquire -> claim -> work -> save
 * progression, so reading one gives you the other's vocabulary.
 *
 * One cycle = one observable state transition. The outer loop in
 * `./worker.ts` maps each result to a sleep via `napForResult` before
 * asking for another cycle. Splitting "what happened" from "how long
 * to wait" keeps timing policy in one place and lets tests drive the
 * state machine directly without waiting on timers.
 *
 * Why this pipeline lives in a worker rather than firing from
 * Chat.svelte's send() like it used to: the in-Chat trigger lost work
 * whenever the user closed the tab (or refreshed) before the single
 * Venice call resolved, leaving the thread on the placeholder title
 * with no retry path other than the round-2+ metadata-message nag the
 * model may or may not act on. The worker re-polls the queue forever,
 * so a fresh thread that lost its first title attempt (network blip,
 * Venice 4xx, page refresh) gets retried as soon as the next cycle
 * sees the row.
 */
import type { VeniceClient } from '../../venice';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import { generateThreadTitle } from '../../title-gen';
import { createLogger } from '../../logger.svelte';

const log = createLogger('auto-title-worker');

export type CycleResult =
  /** Just took the lease on this cycle - no work yet, caller recurses. */
  | 'acquired-lease'
  /** Someone else holds the lease; polling. */
  | 'polling'
  /** Lease held but no thread needs titling. */
  | 'empty-queue'
  /** Claimed, titled, saved. Drain to the next thread. */
  | 'titled'
  /**
   * title-gen returned null (model emitted whitespace, network blip,
   * abort). Claim is released so the row re-enters the queue immediately;
   * the next cycle will retry naturally. Not an error - this is the
   * expected best-effort posture title-gen has always carried.
   */
  | 'no-title'
  /**
   * The save RPC returned false - either the claim was stolen mid-run
   * or the row stopped being eligible (manual rename, model called
   * update_title via the round-2+ nag). Drop the work and drain.
   */
  | 'claim-lost'
  /** Supabase or Venice errored during the cycle. Short back-off. */
  | 'error';

export interface CycleContext {
  venice: VeniceClient;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  /**
   * TTL for the per-thread claim stamped by
   * `claim_next_thread_for_auto_title`. Title generation is one
   * non-streaming Venice call against the fast model, so 60s is
   * plenty with margin - the summary loop uses 120s because its
   * model has more to chew on; titles target a 3-6 word answer
   * (the wire cap is 2048 just for headroom).
   */
  threadClaimTtlSeconds: number;
  signal: AbortSignal;
  onLeaseLost: () => void;
}

export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'empty-queue';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) return 'polling';
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    return 'acquired-lease';
  }

  let claim: { threadId: string; userText: string } | null = null;
  try {
    claim = await ctx.supabase.claimNextThreadForAutoTitle(
      ctx.holderId,
      ctx.threadClaimTtlSeconds
    );
  } catch {
    return 'error';
  }
  if (!claim) return 'empty-queue';

  log.info(`picked up thread ${claim.threadId}`);

  const title = await generateThreadTitle(ctx.venice, claim.userText, ctx.signal);
  if (title === null) {
    // Best-effort: title-gen swallowed whatever went wrong (network,
    // 4xx, abort, empty completion) and returned null. Release the
    // claim so the row goes back to the queue immediately; the next
    // cycle will retry naturally.
    try {
      await ctx.supabase.clearAutoTitleClaim(claim.threadId, ctx.holderId);
    } catch {
      // Best-effort: if the clear RPC fails, the per-thread claim TTL
      // (60s) will let the row re-enter the queue eventually anyway.
    }
    return 'no-title';
  }

  try {
    const saved = await ctx.supabase.saveThreadTitleIfClaimed(
      claim.threadId,
      ctx.holderId,
      title
    );
    if (saved) {
      log.info(`titled thread ${claim.threadId}: ${title}`);
    } else {
      log.debug(
        `claim lost on thread ${claim.threadId} - ` +
          'either the user renamed manually or the model called update_title mid-flight'
      );
    }
    return saved ? 'titled' : 'claim-lost';
  } catch (err) {
    log.debug(
      `save RPC threw for thread ${claim.threadId}`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }
}

export interface NapConfig {
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
}

export function napForResult(result: CycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
    case 'titled':
    case 'no-title':
    case 'claim-lost':
      return 0;
    case 'polling':
      return config.leasePollMs;
    case 'empty-queue':
      return config.idleIntervalMs;
    case 'error':
      return config.errorBackoffMs;
  }
}
