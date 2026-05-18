/**
 * Single-cycle driver for the topics worker. Shape mirrors
 * `../summary/loop.ts` deliberately - the lease-acquire -> claim ->
 * work -> save progression is identical, so reading one gives you the
 * other's vocabulary.
 *
 * The wrinkle vs summary: the claim returns an extra column,
 * `existing_topics`, which is the user's current topic vocabulary at
 * claim time. The agent passes it to the model as a "reuse these
 * names if any apply" list so the dropdown vocabulary stays small
 * and stable. See `./prompt.ts` for the rationale.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { TopicsInput, TopicsOutput } from './agent';
import { createLogger } from '../../logger.svelte';

const log = createLogger('topics-worker');

export type CycleResult =
  /** Just took the lease on this cycle - no work yet, caller recurses. */
  | 'acquired-lease'
  /** Someone else holds the lease; polling. */
  | 'polling'
  /** Lease held but no thread needs tagging. */
  | 'empty-queue'
  /** Claimed, tagged, saved. Drain to the next thread. */
  | 'tagged'
  /**
   * Agent ran but the save RPC returned false - another device took
   * over mid-run. Not an error; drain to the next thread.
   */
  | 'claim-lost'
  /**
   * Agent produced no usable topics (parse failure, all items
   * dropped by validation, model emitted only the reserved
   * sentinel). Claim is released so the row re-enters the queue
   * immediately; the next cycle retries naturally. Not an error -
   * a transient model misbehavior shouldn't cost a TTL wait.
   */
  | 'empty-topics'
  /** Supabase or agent errored during the cycle. Short back-off. */
  | 'error';

export interface CycleContext {
  agent: Agent<TopicsInput, TopicsOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * TTL for the per-thread claim stamped by
   * `claim_next_thread_for_topics`. One non-streaming Venice call
   * with a 512-token cap; 120s mirrors the summary loop and is
   * generous with margin.
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

  let claim: {
    threadId: string;
    terminalMsgId: string;
    existingTopics: string[];
  } | null = null;
  try {
    claim = await ctx.supabase.claimNextThreadForTopics(
      ctx.holderId,
      ctx.threadClaimTtlSeconds
    );
  } catch {
    return 'error';
  }
  if (!claim) return 'empty-queue';

  log.info(
    `picked up thread ${claim.threadId} @ msg ${claim.terminalMsgId} ` +
      `(vocab=${claim.existingTopics.length})`
  );

  let runResult;
  try {
    runResult = await ctx.agent.run({
      input: {
        threadId: claim.threadId,
        terminalMsgId: claim.terminalMsgId,
        existingTopics: claim.existingTopics,
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
    log.debug(
      `thread ${claim.threadId} agent reported error`,
      runResult.error ?? '(no message)'
    );
    return 'error';
  }

  if (runResult.output.topics.length === 0) {
    // Model produced nothing usable. Release the claim so the row
    // re-enters the queue immediately; the next cycle retries. Best-
    // effort: if the clear RPC fails, the per-thread claim TTL will
    // let the row re-enter the queue eventually anyway.
    try {
      await ctx.supabase.clearTopicsClaim(claim.threadId, ctx.holderId);
    } catch {
      // see above
    }
    return 'empty-topics';
  }

  try {
    const saved = await ctx.supabase.saveThreadTopicsIfClaimed(
      claim.threadId,
      ctx.holderId,
      runResult.output.topics,
      claim.terminalMsgId
    );
    if (saved) {
      log.info(
        `tagged thread ${claim.threadId}: [${runResult.output.topics.join(', ')}] ` +
          `(${runResult.output.inputMessageCount} messages in)`
      );
    } else {
      log.debug(
        `claim lost on thread ${claim.threadId} - ` +
          'another device took over mid-tagging'
      );
    }
    return saved ? 'tagged' : 'claim-lost';
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
    case 'tagged':
    case 'claim-lost':
    case 'empty-topics':
      return 0;
    case 'polling':
      return config.leasePollMs;
    case 'empty-queue':
      return config.idleIntervalMs;
    case 'error':
      return config.errorBackoffMs;
  }
}
