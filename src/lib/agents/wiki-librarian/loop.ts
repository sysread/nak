/**
 * Single-cycle driver for the wiki librarian worker. Different shape
 * from the per-conversation wiki / journal / reflection loops:
 *
 *   - No per-thread claim. The librarian operates on the wiki as a
 *     whole, not on a queue of threads.
 *   - Cross-device run-coordination via `claim_wiki_librarian_run` -
 *     the RPC's UPDATE-with-WHERE atomically returns true on at most
 *     one device when the configured minimum interval has elapsed
 *     since the last run.
 *   - Long idle interval. Default min-interval between runs is 12
 *     hours; the loop's idle-nap config matches so we don't poll
 *     more often than we'd consider running.
 *   - Skips trivially-small wikis (< LIBRARIAN_MIN_ARTICLES) without
 *     spending Venice tokens.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type {
  WikiLibrarianInput,
  WikiLibrarianOutput,
} from './types';
import {
  LIBRARIAN_EXCERPT_CHARS,
  LIBRARIAN_MIN_ARTICLES,
} from './types';
import { createLogger } from '../../logger.svelte';

const log = createLogger('wiki-librarian-worker');

export type CycleResult =
  | 'acquired-lease'
  | 'polling'
  | 'too-soon'
  | 'too-small'
  | 'reviewed'
  | 'error';

export interface CycleContext {
  agent: Agent<WikiLibrarianInput, WikiLibrarianOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * Minimum seconds between successive librarian runs (across all
   * devices). The atomic claim RPC enforces this server-side; the
   * loop just passes it through. Default 12h via the worker
   * defaults.
   */
  minIntervalSeconds: number;
  signal: AbortSignal;
  onLeaseLost: () => void;
}

export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'too-soon';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) return 'polling';
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    return 'acquired-lease';
  }

  // Atomic claim. Returns false if another device's run was within
  // the interval. The UPDATE-with-WHERE shape means at most one
  // device's call ever sees the row update.
  let claimed: boolean;
  try {
    claimed = await ctx.supabase.claimWikiLibrarianRun(
      ctx.minIntervalSeconds
    );
  } catch {
    return 'error';
  }
  if (!claimed) return 'too-soon';

  // Snapshot of every article. Same listing the drawer uses, but
  // we cap at 500 (matching listWikiArticles' default) - a librarian
  // run on a wiki of more than 500 articles would be unusual and the
  // prompt would also overflow.
  let articles;
  try {
    articles = await ctx.supabase.listWikiArticles({ limit: 500 });
  } catch (err) {
    log.debug(
      'failed to list wiki articles for librarian',
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }

  if (articles.length < LIBRARIAN_MIN_ARTICLES) {
    log.info(
      `wiki has ${articles.length} article(s); below LIBRARIAN_MIN_ARTICLES, skipping`
    );
    return 'too-small';
  }

  const projection = articles.map((a) => ({
    id: a.id,
    title: a.title,
    excerpt: a.content.slice(0, LIBRARIAN_EXCERPT_CHARS),
  }));

  let runResult;
  try {
    runResult = await ctx.agent.run({
      input: { articles: projection },
      userId: ctx.userId,
      signal: ctx.signal,
    });
  } catch (err) {
    log.debug(
      'librarian agent threw unexpectedly',
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }

  if (runResult.stoppedReason === 'error') {
    log.info(
      `librarian reported error: ${runResult.error ?? '(no message)'}`
    );
    return 'error';
  }

  log.info(
    `librarian finished (${runResult.toolCalls} tool calls over ` +
      `${runResult.output.articleCount} articles)`
  );
  return 'reviewed';
}

export interface NapConfig {
  /** Sleep when we don't hold the lease. */
  leasePollMs: number;
  /** Sleep after `too-soon` / `too-small` / `reviewed`. */
  idleIntervalMs: number;
  errorBackoffMs: number;
}

/**
 * Map cycle outcomes to sleep durations. Most outcomes nap for the
 * idle interval - the librarian is meant to run rarely, and waking
 * up frequently after a no-op cycle would just re-check the claim
 * RPC and discover it's still too soon.
 */
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
