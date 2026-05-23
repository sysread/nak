/**
 * Single-cycle driver for the rem worker. Same shape as the wiki
 * librarian's loop (cross-device coordination via an atomic claim
 * RPC against a singleton timestamp on profiles), but processes up
 * to REM_MAX_CONVERSATIONS_PER_CYCLE eligible conversations per
 * cycle rather than running once over a single batch.
 *
 * Shares the 'memory-librarian' lease partition with the deep-sleep
 * worker - the cross-device mutex.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import {
  REM_MAX_CONVERSATIONS_PER_CYCLE,
  REM_MIN_BATCH_SIZE,
  type RemInput,
  type RemMemoryRow,
  type RemOutput,
} from './types';
import { createLogger } from '../../logger.svelte';

const log = createLogger('rem-worker');

export type CycleResult =
  | 'acquired-lease'
  | 'polling'
  | 'too-soon'
  | 'empty-queue'
  | 'reviewed'
  | 'error';

export interface CycleContext {
  agent: Agent<RemInput, RemOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  minIntervalSeconds: number;
  signal: AbortSignal;
  onLeaseLost: () => void;
  onAgentStart?: () => void;
  onAgentEnd?: () => void;
}

/**
 * Process one conversation: fetch its batch, run the agent (if the
 * batch is large enough to warrant it), mark the conversation's
 * memory_conversation rows processed. Returns true if the agent
 * ran, false if the conversation was skipped (empty batch or too-
 * small batch). The caller stamps the conversation as processed
 * either way - a too-small batch doesn't need to be revisited
 * unless new co-occurrence rows arrive.
 *
 * Exported for tests.
 */
export async function processOneConversation(
  ctx: CycleContext,
  conversationId: string
): Promise<boolean> {
  let memories: Array<{
    memory_id: string;
    label: string;
    data: string;
    confidence: number;
  }>;
  try {
    memories = await ctx.supabase.fetchMemoriesForConversation(conversationId);
  } catch (err) {
    log.info(
      `failed to fetch memories for conversation ${conversationId}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }

  if (memories.length < REM_MIN_BATCH_SIZE) {
    log.info(
      `conversation ${conversationId} has ${memories.length} eligible ` +
        'memor(y/ies); below REM_MIN_BATCH_SIZE, marking processed and skipping'
    );
    try {
      await ctx.supabase.markMemoryConversationProcessed(conversationId);
    } catch (err) {
      log.debug(
        `failed to mark conversation ${conversationId} processed (too-small)`,
        err instanceof Error ? err.message : String(err)
      );
    }
    return false;
  }

  const batch: RemMemoryRow[] = memories.map((m) => ({
    id: m.memory_id,
    label: m.label,
    data: m.data,
    confidence: m.confidence,
  }));

  let runResult;
  ctx.onAgentStart?.();
  try {
    runResult = await ctx.agent.run({
      input: { conversationId, batch },
      userId: ctx.userId,
      signal: ctx.signal,
    });
  } catch (err) {
    log.info(
      `rem agent threw unexpectedly on ${conversationId}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  } finally {
    ctx.onAgentEnd?.();
  }

  if (runResult.stoppedReason === 'error') {
    log.info(
      `rem reported error on ${conversationId}: ${runResult.error ?? '(no message)'}`
    );
    // Do NOT mark processed - we'd lose the opportunity to retry.
    // The next cycle will re-pick this conversation.
    return false;
  }

  try {
    await ctx.supabase.markMemoryConversationProcessed(conversationId);
  } catch (err) {
    log.debug(
      `failed to mark conversation ${conversationId} processed`,
      err instanceof Error ? err.message : String(err)
    );
  }

  const reasoning =
    runResult.output.finalText.replace(/\s+/g, ' ').trim() || '(none)';
  log.info(
    `rem finished ${conversationId} (${runResult.toolCalls} tool calls over ` +
      `${runResult.output.batchSize} memories, reasoning="${reasoning}")`
  );
  return true;
}

export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'too-soon';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) {
      log.debug('polling for lease (another memory-librarian device holds it)');
      return 'polling';
    }
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    log.info('lease acquired - checking eligibility on the next cycle');
    return 'acquired-lease';
  }

  let claimed: boolean;
  try {
    claimed = await ctx.supabase.claimRemRun(ctx.minIntervalSeconds);
  } catch (err) {
    log.info(
      `claim RPC failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  }
  if (!claimed) {
    const hours = Math.round(ctx.minIntervalSeconds / 3600);
    log.info(
      `not yet eligible for a rem run ` +
        `(min interval ${hours}h since last successful run)`
    );
    return 'too-soon';
  }
  log.info('claim acquired - starting rem run');

  let conversationIds: string[];
  try {
    conversationIds = await ctx.supabase.pickRemEligibleConversations(
      REM_MAX_CONVERSATIONS_PER_CYCLE
    );
  } catch (err) {
    log.info(
      `failed to fetch eligible conversations: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  }
  if (conversationIds.length === 0) {
    log.info('no conversations eligible for rem; skipping');
    return 'empty-queue';
  }

  let anyProcessed = false;
  for (const conversationId of conversationIds) {
    if (ctx.signal.aborted) break;
    const processed = await processOneConversation(ctx, conversationId);
    anyProcessed = anyProcessed || processed;
  }

  return anyProcessed ? 'reviewed' : 'empty-queue';
}

export interface NapConfig {
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
}

export function napForResult(result: CycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
      return 0;
    case 'polling':
      return config.leasePollMs;
    case 'too-soon':
    case 'empty-queue':
    case 'reviewed':
      return config.idleIntervalMs;
    case 'error':
      return config.errorBackoffMs;
  }
}
