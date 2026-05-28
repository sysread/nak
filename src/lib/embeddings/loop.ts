/**
 * Single-cycle driver for the embeddings worker. Factored out of
 * `./worker.ts` so it can be unit-tested without a Web Worker runtime:
 * the Worker entry point is a thin wrapper that calls `runOneCycle`
 * repeatedly until its AbortSignal trips.
 *
 * One cycle = one observable state transition: acquire the lease,
 * notice contention, claim a row, embed it, save, or recover from an
 * error. Each cycle returns a `CycleResult` that the outer loop maps
 * to a sleep duration via `napForResult`. Separating the "what
 * happened" from "how long to wait" keeps timing policy in one place
 * and makes both pieces testable independently.
 */
import { VeniceError } from '../venice';
import { padEmbeddingForStorage } from '../models';
import type { EmbeddingSource } from './types';
import type { LeaseCoordinator } from './lease';
import { createLogger } from '../logger.svelte';

const log = createLogger('embed-worker');

export type CycleResult =
  /** Just took the lease on this cycle — no work yet, caller should recurse immediately. */
  | 'acquired-lease'
  /** Someone else holds the lease; we're polling until it expires. */
  | 'polling'
  /** Lease held but the queue is empty — idle sleep before the next poll. */
  | 'empty-queue'
  /** Claimed, embedded, saved. Drain to the next row without sleeping. */
  | 'embedded'
  /**
   * Claimed and embedded but save returned false — the row was edited
   * out from under us, TTL lapsed, or the row was deleted. Not an
   * error; drain to the next row.
   */
  | 'save-rejected'
  /** Venice returned no embedding for a non-empty input. Treat like save-rejected. */
  | 'no-embedding'
  /** Venice rate-limited us. Long back-off. */
  | 'rate-limited'
  /** Venice or Supabase errored. Short back-off. */
  | 'error';

/**
 * Produce an embedding for `input`, or undefined/empty when the provider
 * returned no vector. Throws VeniceError on failure - the loop maps a
 * `rate_limit` kind to a back-off. The worker injects this: it routes
 * through the venice edge function and falls back to a direct Venice call
 * (see docs/dev/in-progress/venice-edge-functions/), so the loop stays
 * agnostic about where the vector comes from.
 */
export type Embedder = (input: string, signal: AbortSignal) => Promise<number[] | undefined>;

export interface CycleContext {
  source: EmbeddingSource;
  embed: Embedder;
  coordinator: LeaseCoordinator;
  holderId: string;
  embeddingModel: string;
  rowClaimTtlSeconds: number;
  signal: AbortSignal;
  /**
   * Callback fired by the heartbeat if the lease is lost. Supplied once
   * when the cycle driver starts — not per cycle — but we pass it
   * through `runOneCycle` so the caller can keep the wiring obvious.
   */
  onLeaseLost: () => void;
}

/**
 * Drive exactly one cycle of the work loop. The outer loop is just
 * `while (!signal.aborted) { await runOneCycle(...); await sleep(napForResult(...)); }`.
 * Tests drive `runOneCycle` directly without needing to wait on real
 * time.
 */
export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'empty-queue';

  // Top of cycle: if we don't hold the lease, try to take it. We
  // purposely don't heartbeat while polling — we're not holding
  // anything to keep alive.
  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) return 'polling';
    // Wire the heartbeat now that we have something to defend. This is
    // idempotent so restart-after-loss works without special casing.
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    return 'acquired-lease';
  }

  // We hold the lease — do one unit of work.
  let claimed: { id: string; input: string } | null = null;
  try {
    claimed = await ctx.source.claimNext(ctx.holderId, ctx.rowClaimTtlSeconds);
  } catch {
    // Claim failures are transient (network, conflicting lock). Bail to
    // the error back-off; next cycle will retry.
    return 'error';
  }
  if (!claimed) return 'empty-queue';

  // Task pickup — one log per claimed row so the log drawer can
  // surface the worker's activity. .info for the headline, .debug
  // for the input preview (which can be noisy and is only useful
  // when actively debugging an embedding).
  log.info(`picked up ${ctx.source.name} row ${claimed.id}`);
  log.debug(
    `row ${claimed.id} input (${claimed.input.length} chars)`,
    claimed.input.length > 200 ? claimed.input.slice(0, 200) + '…' : claimed.input
  );

  let rawEmbedding: number[] | undefined;
  try {
    rawEmbedding = await ctx.embed(claimed.input, ctx.signal);
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') return 'rate-limited';
    return 'error';
  }
  if (!rawEmbedding || rawEmbedding.length === 0) return 'no-embedding';

  // Pad for storage. The column is wider than the current model so a
  // future 2048-dim model can land without an ALTER. padEmbeddingForStorage
  // throws only if the input is *longer* than storage dim — a config
  // bug we want to surface loudly, not paper over.
  const padded = padEmbeddingForStorage(rawEmbedding);

  let saved: boolean;
  try {
    saved = await ctx.source.save(claimed.id, ctx.holderId, padded, ctx.embeddingModel);
  } catch {
    return 'error';
  }
  if (saved) {
    log.info(`finished ${ctx.source.name} row ${claimed.id}`);
  } else {
    log.debug(
      `save rejected for ${ctx.source.name} row ${claimed.id} - ` +
        'row was edited, claim expired, or the row was deleted'
    );
  }
  return saved ? 'embedded' : 'save-rejected';
}

/** Tunables the outer loop maps cycle results to sleep durations with. */
export interface NapConfig {
  /** Sleep after 'polling' — we don't hold the lease. */
  leasePollMs: number;
  /** Sleep after 'empty-queue' — we hold the lease but nothing to do. */
  idleIntervalMs: number;
  /** Sleep after 'error' — Venice/Supabase transient failure. */
  errorBackoffMs: number;
  /** Sleep after 'rate-limited' — Venice 429. */
  rateLimitBackoffMs: number;
}

/**
 * Map cycle outcomes to the sleep duration before the next cycle. Zero
 * means "run the next cycle immediately" — used for results that
 * represent forward progress (a row embedded or skipped; the lease just
 * acquired) where we want to drain the queue as fast as we can.
 */
export function napForResult(result: CycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
    case 'embedded':
    case 'save-rejected':
    case 'no-embedding':
      return 0;
    case 'polling':
      return config.leasePollMs;
    case 'empty-queue':
      return config.idleIntervalMs;
    case 'error':
      return config.errorBackoffMs;
    case 'rate-limited':
      return config.rateLimitBackoffMs;
  }
}

/**
 * Signal-aware sleep. Exits early if `signal` aborts, so a stop
 * message doesn't wait out a 30-second idle tick. Exported for reuse by
 * the worker entry point and for tests that want to confirm the early
 * return behavior.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

