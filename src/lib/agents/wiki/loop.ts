/**
 * Single-cycle driver for the wiki worker. Mirrors
 * `../reflection/loop.ts`: acquire lease -> claim thread -> run
 * agent -> mark pointer.
 *
 * The pointer-advance is unconditional on `done`. The autonomous
 * agent's `wiki_*` tool calls land their side effects directly; even
 * a no-op cycle (the agent decided no topic warranted a wiki update)
 * advances the pointer so the same conversation is not re-processed
 * every cycle. New turns added to the thread will reset eligibility
 * via the next-day predicate in `claim_next_thread_for_wiki`.
 *
 * Error path: the agent's `stoppedReason === 'error'` branch does NOT
 * mark the thread processed - it calls `record_wiki_failure_or_skip`
 * which increments a per-thread counter and either releases the claim
 * (so the next cycle retries quickly) or, once the counter reaches
 * `maxFailuresPerThread`, advances the pointer to skip the thread.
 * Skipping protects against pinning the queue on a permanently-
 * filtered conversation (Venice's content classifier rejecting the
 * same text every attempt). The skipped thread rejoins the queue only
 * when a new turn changes the terminal message, giving the filter a
 * fresh body to evaluate.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { WikiInput, WikiOutput } from './types';
import { createLogger } from '../../logger.svelte';

const log = createLogger('wiki-worker');

export type CycleResult =
  | 'acquired-lease'
  | 'polling'
  | 'empty-queue'
  | 'processed'
  /**
   * Agent errored and the per-thread failure counter reached the cap.
   * Pointer was advanced (the failing terminal message is now behind
   * us); claim was cleared. Drain to the next thread.
   */
  | 'skipped'
  | 'claim-lost'
  | 'error';

export interface CycleContext {
  agent: Agent<WikiInput, WikiOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * IANA timezone the next-day eligibility predicate buckets against.
   * May be null (user has not set a preference); the SQL fallback
   * coerces null to UTC so the day-gate still works.
   */
  timezone: string | null;
  threadClaimTtlSeconds: number;
  /**
   * Consecutive-failure cap per thread. When the agent errors this
   * many times against the same terminal message, the pointer is
   * advanced (skipping the thread for this round of turns) rather
   * than retrying forever. Set in `manager.ts`'s WORKER_DEFAULTS.
   */
  maxFailuresPerThread: number;
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

  let claim: {
    threadId: string;
    terminalMsgId: string;
    title: string | null;
    newestMsgAt: string;
  } | null = null;
  try {
    claim = await ctx.supabase.claimNextThreadForWiki(
      ctx.holderId,
      ctx.threadClaimTtlSeconds,
      ctx.timezone
    );
  } catch {
    return 'error';
  }
  if (!claim) return 'empty-queue';

  const titleTag = claim.title ? `"${claim.title}"` : '[untitled]';
  log.info(
    `picked up thread ${claim.threadId} @ msg ${claim.terminalMsgId} ${titleTag}`
  );

  let runResult;
  try {
    runResult = await ctx.agent.run({
      input: {
        threadId: claim.threadId,
        terminalMsgId: claim.terminalMsgId,
      },
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
    // Side effects from any wiki_* tool calls already landed (the
    // wiki tools are owned by the user, not the claim). The failure
    // RPC increments a per-thread counter and decides whether to
    // release the claim (retry on the next cycle) or advance the
    // pointer (give up after N attempts so a permanently-filtered
    // thread doesn't pin the queue).
    const errMsg = runResult.error ?? '(no message)';
    let outcome: 'released' | 'skipped' | 'claim-lost';
    try {
      outcome = await ctx.supabase.recordWikiFailureOrSkip(
        claim.threadId,
        ctx.holderId,
        claim.terminalMsgId,
        ctx.maxFailuresPerThread,
        errMsg
      );
    } catch (rpcErr) {
      // Counter bookkeeping failed. The original agent error is
      // still the headline; surface both so an operator reading the
      // drawer can correlate them. The claim TTL (10 min) will sweep
      // the row regardless, so we still make forward progress -
      // just on the slower fallback path.
      log.info(
        `thread ${claim.threadId} agent reported error: ` +
          `${errMsg} ${titleTag} ` +
          `(failure RPC also threw: ${
            rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
          })`
      );
      return 'error';
    }
    if (outcome === 'skipped') {
      log.warn(
        `thread ${claim.threadId} agent reported error: ${errMsg} ` +
          `(reached failure cap; pointer advanced to skip) ${titleTag}`
      );
      return 'skipped';
    }
    if (outcome === 'claim-lost') {
      log.debug(
        `thread ${claim.threadId} agent reported error: ${errMsg} ` +
          `(claim already gone; another device will retry) ${titleTag}`
      );
      return 'claim-lost';
    }
    log.info(
      `thread ${claim.threadId} agent reported error: ${errMsg} ` +
        `(claim released; will retry next cycle) ${titleTag}`
    );
    return 'error';
  }

  // Done. Advance the pointer regardless of whether the agent wrote
  // anything - a no-op cycle (model decided no topic warranted an
  // article) still consumed the conversation, and re-processing it
  // every cycle would be wasted Venice spend.
  let marked = false;
  try {
    marked = await ctx.supabase.markThreadWikiProcessedIfClaimed(
      claim.threadId,
      ctx.holderId,
      claim.terminalMsgId
    );
  } catch (err) {
    log.debug(
      `mark RPC threw for thread ${claim.threadId}`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }
  if (marked) {
    // Reasoning is the agent's brief operator-facing summary of what
    // it did and why (see WIKI_AUTONOMOUS_BODY_LINES' "Final reply"
    // block in ../wiki/prompt.ts). Normalise whitespace so a stray
    // newline does not break the single-line log convention, and
    // fall back to a sentinel when the model returned an empty
    // string (shouldn't happen in production, but a missing summary
    // is still better surfaced as "(none)" than a dangling `reasoning=""`).
    const reasoning =
      runResult.output.finalText.replace(/\s+/g, ' ').trim() || '(none)';
    log.info(
      `finished thread ${claim.threadId} ` +
        `(${runResult.toolCalls} tool calls over ${runResult.output.inputMessageCount} messages, ` +
        `reasoning="${reasoning}") ${titleTag}`
    );
    return 'processed';
  }
  log.debug(
    `claim lost on thread ${claim.threadId} - another device took over ${titleTag}`
  );
  return 'claim-lost';
}

export interface NapConfig {
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
}

export function napForResult(result: CycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
    case 'processed':
    case 'skipped':
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
