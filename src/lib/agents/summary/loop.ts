/**
 * Single-cycle driver for the summary work unit. The supervisor
 * (`../supervisor/`) imports this `runOneCycle` and drives it; the
 * supervisor owns the sleep policy for the whole supervised batch, so
 * this module just reports what happened. Factoring the state machine
 * out keeps it unit-testable without a Web Worker runtime, and mirrors
 * the sibling unit loops (`../wiki/loop.ts`, `../topics/loop.ts`)
 * deliberately - they share the lease-acquire -> claim -> work -> save
 * progression, so reading one gives you the others' vocabulary.
 *
 * One cycle = one observable state transition. Splitting "what
 * happened" (this module) from "how long to wait" (the supervisor's nap
 * policy) lets tests drive the state machine directly without waiting
 * on timers.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { SummaryInput, SummaryOutput } from './agent';
import { createLogger } from '../../logger.svelte';

const log = createLogger('summary-worker');

export type CycleResult =
  /** Just took the lease on this cycle — no work yet, caller recurses. */
  | 'acquired-lease'
  /** Someone else holds the lease; polling. */
  | 'polling'
  /** Lease held but no thread needs summarising. */
  | 'empty-queue'
  /** Claimed, summarised, saved. Drain to the next thread. */
  | 'summarised'
  /**
   * Agent ran but the save RPC returned false — another device took
   * over mid-run. Not an error; drain to the next thread.
   */
  | 'claim-lost'
  /** Agent produced an empty summary — treat like claim-lost (skip). */
  | 'empty-summary'
  /** Supabase or agent errored during the cycle. Short back-off. */
  | 'error';

export interface CycleContext {
  agent: Agent<SummaryInput, SummaryOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * TTL for the per-thread claim stamped by
   * `claim_next_thread_for_summary`. A summary is one non-streaming
   * Venice call, so 120s is plenty with margin — the reflection loop
   * uses 600s because it can span multiple tool rounds, which we
   * don't have here.
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

  let claim: { threadId: string; terminalMsgId: string } | null = null;
  try {
    claim = await ctx.supabase.claimNextThreadForSummary(
      ctx.holderId,
      ctx.threadClaimTtlSeconds
    );
  } catch {
    return 'error';
  }
  if (!claim) return 'empty-queue';

  log.info(
    `picked up thread ${claim.threadId} @ msg ${claim.terminalMsgId}`
  );

  let runResult;
  try {
    runResult = await ctx.agent.run({
      input: { threadId: claim.threadId, terminalMsgId: claim.terminalMsgId },
      userId: ctx.userId,
      threadId: claim.threadId,
      signal: ctx.signal,
    });
  } catch (err) {
    log.debug(
      `thread ${claim.threadId} threw unexpectedly`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }

  if (runResult.stoppedReason === 'aborted') return 'empty-queue';
  if (runResult.stoppedReason === 'error') {
    log.debug(
      `thread ${claim.threadId} agent reported error`,
      runResult.error ?? '(no message)'
    );
    return 'error';
  }

  if (!runResult.output.summary) {
    // Model refused or returned only whitespace. Don't save — saving
    // an empty string would mark the thread "summarised" and never
    // retry. Leaving the claim stamped until TTL means the row gets
    // another chance on the next cycle, which is the right recovery
    // for a transient model misbehavior. Worst case, the TTL expires
    // and a later cycle re-claims and tries again.
    return 'empty-summary';
  }

  try {
    const saved = await ctx.supabase.saveThreadSummaryIfClaimed(
      claim.threadId,
      ctx.holderId,
      runResult.output.summary,
      claim.terminalMsgId
    );
    if (saved) {
      log.info(
        `finished thread ${claim.threadId} ` +
          `(${runResult.output.inputMessageCount} messages in)`
      );
    } else {
      log.debug(
        `claim lost on thread ${claim.threadId} - ` +
          'another device took over mid-summary'
      );
    }
    return saved ? 'summarised' : 'claim-lost';
  } catch (err) {
    log.debug(
      `save RPC threw for thread ${claim.threadId}`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }
}
