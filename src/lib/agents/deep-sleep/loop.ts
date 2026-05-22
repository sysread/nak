/**
 * Single-cycle driver for the deep-sleep worker. Same shape as the
 * wiki librarian's loop (no per-row claim; cross-device coordination
 * via an atomic claim RPC against a singleton timestamp on profiles),
 * but the work unit is different:
 *
 *   1. Pick the oldest-unvisited memory as the seed.
 *   2. Embed the seed and vector-search the rest of the user's
 *      memories for the top-k neighbors above the similarity
 *      threshold (DEEP_SLEEP_MIN_SIMILARITY = 0.80).
 *   3. Hand the batch (seed + neighbors) to the agent.
 *   4. After the run, mark the entire batch as visited so the next
 *      sweep picks a different neighborhood.
 *
 * Shares the 'memory-librarian' lease partition with the rem worker,
 * which IS the cross-device mutex - only one of the two librarians
 * can run at a time per user.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { VeniceClient } from '../../venice';
import type { LeaseCoordinator } from '../../embeddings/lease';
import {
  DEEP_SLEEP_MAX_NEIGHBORS,
  DEEP_SLEEP_MIN_BATCH_SIZE,
  DEEP_SLEEP_MIN_SIMILARITY,
  type DeepSleepInput,
  type DeepSleepMemoryRow,
  type DeepSleepOutput,
} from './types';
import { padEmbeddingForStorage, VENICE_EMBEDDING_MODEL } from '../../models';
import { createLogger } from '../../logger.svelte';

const log = createLogger('deep-sleep-worker');

export type CycleResult =
  | 'acquired-lease'
  | 'polling'
  | 'too-soon'
  | 'too-small'
  | 'reviewed'
  | 'error';

export interface CycleContext {
  agent: Agent<DeepSleepInput, DeepSleepOutput>;
  supabase: SupabaseService;
  venice: VeniceClient;
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
 * Pick the seed, fetch neighbors, run the agent, mark visited.
 * Exported for tests; the worker uses it via runOneCycle.
 */
export async function buildBatchForSeed(
  supabase: SupabaseService,
  venice: VeniceClient,
  seed: {
    id: string;
    label: string;
    data: string;
    confidence: number;
  },
  signal: AbortSignal
): Promise<DeepSleepMemoryRow[]> {
  // Embed the seed against Venice. The seed's existing embedding in
  // the DB is the truthful one to query against, but pgvector
  // doesn't have a "get the embedding back" RPC and re-embedding is
  // cheap - the bge-m3 model's input is bounded by the memory's
  // 8000-char data cap, well under the model's window.
  const probe = `${seed.label}: ${seed.data}`.slice(0, 8000);
  const response = await venice.embed({
    model: VENICE_EMBEDDING_MODEL,
    input: probe,
    signal,
  });
  const raw = response.data[0]?.embedding;
  if (!raw || raw.length === 0) {
    return [{ id: seed.id, label: seed.label, data: seed.data, confidence: seed.confidence, score: 1.0 }];
  }
  const padded = padEmbeddingForStorage(raw);

  // Pull a generous overfetch of similarity hits so we can filter
  // the seed itself out and still land MAX_NEIGHBORS. The scored RPC
  // returns similarities in [0, 1] (cosine, post-boost).
  const scored = await supabase.searchMemoriesByEmbeddingScored(
    padded,
    DEEP_SLEEP_MAX_NEIGHBORS + 4
  );
  const neighbors = scored
    .filter((row) => row.id !== seed.id)
    .filter((row) => row.similarity >= DEEP_SLEEP_MIN_SIMILARITY)
    .slice(0, DEEP_SLEEP_MAX_NEIGHBORS)
    .map((row) => ({
      id: row.id,
      label: row.label,
      data: row.data,
      confidence: row.confidence,
      score: row.similarity,
    }));
  return [
    {
      id: seed.id,
      label: seed.label,
      data: seed.data,
      confidence: seed.confidence,
      score: 1.0,
    },
    ...neighbors,
  ];
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
    claimed = await ctx.supabase.claimDeepSleepRun(ctx.minIntervalSeconds);
  } catch (err) {
    log.info(
      `claim RPC failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  }
  if (!claimed) {
    const hours = Math.round(ctx.minIntervalSeconds / 3600);
    log.info(
      `not yet eligible for a deep-sleep run ` +
        `(min interval ${hours}h since last successful run)`
    );
    return 'too-soon';
  }
  log.info('claim acquired - starting deep-sleep run');

  let seed;
  try {
    seed = await ctx.supabase.pickDeepSleepSeed();
  } catch (err) {
    log.info(
      `failed to pick deep-sleep seed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  }
  if (!seed) {
    log.info('no eligible memories for deep-sleep; skipping');
    return 'too-small';
  }

  let batch: DeepSleepMemoryRow[];
  try {
    batch = await buildBatchForSeed(ctx.supabase, ctx.venice, seed, ctx.signal);
  } catch (err) {
    log.info(
      `failed to build deep-sleep batch: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  }

  if (batch.length < DEEP_SLEEP_MIN_BATCH_SIZE) {
    // Seed has no similarity neighbors above the threshold. Stamp
    // the seed's visit timestamp so the next sweep moves on; no
    // need to run the agent on a single-row batch.
    log.info(
      `seed ${seed.id} has no neighbors above ${DEEP_SLEEP_MIN_SIMILARITY}; ` +
        'marking visited and skipping'
    );
    try {
      await ctx.supabase.markMemoriesLibrarianVisited([seed.id]);
    } catch (err) {
      log.debug(
        'failed to stamp visit timestamp on lonely seed',
        err instanceof Error ? err.message : String(err)
      );
    }
    return 'too-small';
  }

  let runResult;
  ctx.onAgentStart?.();
  try {
    runResult = await ctx.agent.run({
      input: { batch },
      userId: ctx.userId,
      signal: ctx.signal,
    });
  } catch (err) {
    log.info(
      `deep-sleep agent threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  } finally {
    ctx.onAgentEnd?.();
  }

  if (runResult.stoppedReason === 'error') {
    log.info(
      `deep-sleep reported error: ${runResult.error ?? '(no message)'}`
    );
    return 'error';
  }

  // Mark the entire batch as visited. Per the "mark all five"
  // decision in the design conversation: marking only the seed would
  // mean the next cycle picks one of the neighbors and re-inspects
  // the same neighborhood. Similarity space drifts slowly; accept
  // the imperfection that B-as-seed never gets its own perspective
  // until the next-after-next sweep.
  try {
    await ctx.supabase.markMemoriesLibrarianVisited(batch.map((m) => m.id));
  } catch (err) {
    log.debug(
      'failed to stamp visit timestamps on batch',
      err instanceof Error ? err.message : String(err)
    );
  }

  const reasoning =
    runResult.output.finalText.replace(/\s+/g, ' ').trim() || '(none)';
  log.info(
    `deep-sleep finished (${runResult.toolCalls} tool calls over ` +
      `${runResult.output.batchSize} memories, reasoning="${reasoning}")`
  );
  return 'reviewed';
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
    case 'too-small':
    case 'reviewed':
      return config.idleIntervalMs;
    case 'error':
      return config.errorBackoffMs;
  }
}
