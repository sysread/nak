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
    // wiki tools are owned by the user, not the claim). Don't
    // advance the pointer - next cycle will retry.
    log.info(
      `thread ${claim.threadId} agent reported error: ` +
        `${runResult.error ?? '(no message)'} ${titleTag}`
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
