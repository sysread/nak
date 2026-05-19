/**
 * Single-cycle driver for the recipe-topics worker. Shape mirrors
 * `../memory_topics/loop.ts` deliberately - the transitions are
 * identical. The wrinkles vs the memory topics loop: the claim
 * returns title + cooklang (not label + data), and the save
 * signature doesn't take a msg_id (eligibility is driven by
 * `last_topics_at` and the title/cooklang trigger).
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { RecipeTopicsInput, RecipeTopicsOutput } from './agent';
import { createLogger } from '../../logger.svelte';

const log = createLogger('recipe-topics-worker');

export type CycleResult =
  /** Just took the lease on this cycle - no work yet, caller recurses. */
  | 'acquired-lease'
  /** Someone else holds the lease; polling. */
  | 'polling'
  /** Lease held but no recipe needs tagging. */
  | 'empty-queue'
  /** Claimed, tagged, saved. Drain to the next recipe. */
  | 'tagged'
  /**
   * Agent ran but the save RPC returned false - another device took
   * over mid-run, or the user edited the recipe between claim and
   * save and the trigger nulled our claim. Not an error; drain to
   * the next recipe.
   */
  | 'claim-lost'
  /**
   * Agent produced no usable topics. Claim is released so the row
   * re-enters the queue immediately; the next cycle retries.
   */
  | 'empty-topics'
  /** Supabase or agent errored during the cycle. Short back-off. */
  | 'error';

export interface CycleContext {
  agent: Agent<RecipeTopicsInput, RecipeTopicsOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * TTL for the per-recipe claim stamped by
   * `claim_next_recipe_for_topics`. One non-streaming Venice call
   * with a 384-token cap; 60s mirrors the memory-topics TTL and is
   * comfortable margin.
   */
  recipeClaimTtlSeconds: number;
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
    recipeId: string;
    title: string;
    cooklang: string;
    existingTopics: string[];
  } | null = null;
  try {
    claim = await ctx.supabase.claimNextRecipeForTopics(
      ctx.holderId,
      ctx.recipeClaimTtlSeconds
    );
  } catch {
    return 'error';
  }
  if (!claim) return 'empty-queue';

  log.info(
    `picked up recipe ${claim.recipeId} (vocab=${claim.existingTopics.length})`
  );

  let runResult;
  try {
    runResult = await ctx.agent.run({
      input: {
        recipeId: claim.recipeId,
        title: claim.title,
        cooklang: claim.cooklang,
        existingTopics: claim.existingTopics,
      },
      userId: ctx.userId,
      // Reuse the recipe id as the threadId in the run request.
      // Recipes are not thread-scoped; the field exists on
      // AgentRunRequest for trace correlation and a recipe uuid is
      // unambiguous (no thread shares a uuid with a recipe). Same
      // posture as `../memory_topics/loop.ts`.
      threadId: claim.recipeId,
      signal: ctx.signal,
    });
  } catch (err) {
    log.debug(
      `recipe ${claim.recipeId} threw unexpectedly`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }

  if (runResult.stoppedReason === 'aborted') return 'empty-queue';
  if (runResult.stoppedReason === 'error') {
    log.debug(
      `recipe ${claim.recipeId} agent reported error`,
      runResult.error ?? '(no message)'
    );
    return 'error';
  }

  if (runResult.output.topics.length === 0) {
    // Model produced nothing usable. Release the claim so the row
    // re-enters the queue immediately. Best-effort: if the clear
    // RPC fails, the per-recipe claim TTL will let the row re-enter
    // the queue eventually anyway.
    try {
      await ctx.supabase.clearRecipeTopicsClaim(claim.recipeId, ctx.holderId);
    } catch {
      // see above
    }
    return 'empty-topics';
  }

  try {
    const saved = await ctx.supabase.saveRecipeTopicsIfClaimed(
      claim.recipeId,
      ctx.holderId,
      runResult.output.topics
    );
    if (saved) {
      log.info(
        `tagged recipe ${claim.recipeId}: [${runResult.output.topics.join(', ')}]`
      );
    } else {
      log.debug(
        `claim lost on recipe ${claim.recipeId} - ` +
          'another device took over mid-tagging, or the recipe was edited'
      );
    }
    return saved ? 'tagged' : 'claim-lost';
  } catch (err) {
    log.debug(
      `save RPC threw for recipe ${claim.recipeId}`,
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
