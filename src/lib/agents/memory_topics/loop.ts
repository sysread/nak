/**
 * Single-cycle driver for the memory-topics worker. Shape mirrors
 * `../topics/loop.ts` deliberately - the lease-acquire -> claim ->
 * work -> save progression is identical, so reading either one gives
 * you the other's vocabulary.
 *
 * The wrinkles vs the thread topics loop:
 *
 *   1. The claim returns label + data (the memory's text) rather than
 *      a thread id + terminal-msg id. The agent's input is the memory
 *      itself; no second SELECT inside the agent.
 *   2. The save guard doesn't take a `msg_id` argument - eligibility
 *      is driven by `last_topics_at`, which the save stamps to `now()`.
 *      A content-change trigger nulls last_topics_at to re-queue the
 *      row on the next cycle.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { MemoryTopicsInput, MemoryTopicsOutput } from './agent';
import { createLogger } from '../../logger.svelte';

const log = createLogger('memory-topics-worker');

export type CycleResult =
  /** Just took the lease on this cycle - no work yet, caller recurses. */
  | 'acquired-lease'
  /** Someone else holds the lease; polling. */
  | 'polling'
  /** Lease held but no memory needs tagging. */
  | 'empty-queue'
  /** Claimed, tagged, saved. Drain to the next memory. */
  | 'tagged'
  /**
   * Agent ran but the save RPC returned false - another device took
   * over mid-run, or the user edited the memory between claim and
   * save and the trigger nulled our claim. Not an error; drain to
   * the next memory.
   */
  | 'claim-lost'
  /**
   * Agent produced no usable topics (parse failure, all items dropped
   * by validation, model emitted only the reserved sentinel). Claim
   * is released so the row re-enters the queue immediately; the next
   * cycle retries naturally.
   */
  | 'empty-topics'
  /** Supabase or agent errored during the cycle. Short back-off. */
  | 'error';

export interface CycleContext {
  agent: Agent<MemoryTopicsInput, MemoryTopicsOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * TTL for the per-memory claim stamped by
   * `claim_next_memory_for_topics`. One non-streaming Venice call
   * with a 256-token cap; 60s is comfortable margin. Shorter than
   * the thread topics worker (120s) because the memory text is
   * bounded - no 120-message conversation to feed through.
   */
  memoryClaimTtlSeconds: number;
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
    memoryId: string;
    label: string;
    data: string;
    existingTopics: string[];
  } | null = null;
  try {
    claim = await ctx.supabase.claimNextMemoryForTopics(
      ctx.holderId,
      ctx.memoryClaimTtlSeconds
    );
  } catch {
    return 'error';
  }
  if (!claim) return 'empty-queue';

  log.info(
    `picked up memory ${claim.memoryId} (vocab=${claim.existingTopics.length})`
  );

  let runResult;
  try {
    runResult = await ctx.agent.run({
      input: {
        memoryId: claim.memoryId,
        label: claim.label,
        data: claim.data,
        existingTopics: claim.existingTopics,
      },
      userId: ctx.userId,
      // The agent is memory-scoped, not thread-scoped. We still pass
      // a threadId to satisfy AgentRunRequest's shape - reusing the
      // memoryId is unambiguous (no thread will ever share a uuid
      // with a memory) and any logger output threads the id through
      // for trace correlation. See `../types.ts`.
      threadId: claim.memoryId,
      signal: ctx.signal,
    });
  } catch (err) {
    log.debug(
      `memory ${claim.memoryId} threw unexpectedly`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }

  if (runResult.stoppedReason === 'aborted') return 'empty-queue';
  if (runResult.stoppedReason === 'error') {
    log.debug(
      `memory ${claim.memoryId} agent reported error`,
      runResult.error ?? '(no message)'
    );
    return 'error';
  }

  if (runResult.output.topics.length === 0) {
    // Model produced nothing usable. Release the claim so the row
    // re-enters the queue immediately; the next cycle retries. Best-
    // effort: if the clear RPC fails, the per-memory claim TTL will
    // let the row re-enter the queue eventually anyway.
    try {
      await ctx.supabase.clearMemoryTopicsClaim(claim.memoryId, ctx.holderId);
    } catch {
      // see above
    }
    return 'empty-topics';
  }

  try {
    const saved = await ctx.supabase.saveMemoryTopicsIfClaimed(
      claim.memoryId,
      ctx.holderId,
      runResult.output.topics
    );
    if (saved) {
      log.info(
        `tagged memory ${claim.memoryId}: [${runResult.output.topics.join(', ')}]`
      );
    } else {
      log.debug(
        `claim lost on memory ${claim.memoryId} - ` +
          'another device took over mid-tagging, or the memory was edited'
      );
    }
    return saved ? 'tagged' : 'claim-lost';
  } catch (err) {
    log.debug(
      `save RPC threw for memory ${claim.memoryId}`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }
}
