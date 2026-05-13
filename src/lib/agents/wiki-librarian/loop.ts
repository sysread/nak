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
  /**
   * Fires immediately before `agent.run()` and again after it returns,
   * regardless of success/failure. The worker uses these to post a
   * `{type:'busy', busy:true/false}` outbound message so the main-
   * thread manager can light up a "background librarian is currently
   * running" flag. The Wiki top-bar reads that flag to gray out the
   * manual-run button - we don't want the user kicking off a second
   * run on top of the scheduled one. Optional so tests can omit them.
   */
  onAgentStart?: () => void;
  onAgentEnd?: () => void;
}

export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'too-soon';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) {
      // Polling fires every leasePollMs; .debug rather than .info so
      // an idle librarian doesn't spam the drawer with a "still
      // polling" line every minute. The acquired-lease branch below
      // does land at .info so the user sees the transition.
      log.debug('polling for lease (another device holds it)');
      return 'polling';
    }
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    log.info('lease acquired - checking eligibility on the next cycle');
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
  } catch (err) {
    log.info(
      `claim RPC failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  }
  if (!claimed) {
    // Logged at .info so the user can see "yes, the librarian is
    // alive and waiting" without enabling debug. Idle nap is 1h, so
    // this lands ~24 lines/day during the 12h cooldown - not noisy.
    // The interval is named explicitly so the user knows the next
    // attempt timing without doing the math.
    const hours = Math.round(ctx.minIntervalSeconds / 3600);
    log.info(
      `not yet eligible for a librarian run ` +
        `(min interval ${hours}h since last successful run)`
    );
    return 'too-soon';
  }
  log.info('claim acquired - starting librarian run');

  // Snapshot of every article. Same listing the drawer uses, but
  // we cap at 500 (matching listWikiArticles' default) - a librarian
  // run on a wiki of more than 500 articles would be unusual and the
  // prompt would also overflow.
  let articles;
  try {
    articles = await ctx.supabase.listWikiArticles({ limit: 500 });
  } catch (err) {
    log.info(
      `failed to list wiki articles: ${err instanceof Error ? err.message : String(err)}`
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
  ctx.onAgentStart?.();
  try {
    runResult = await ctx.agent.run({
      input: { articles: projection },
      userId: ctx.userId,
      signal: ctx.signal,
    });
  } catch (err) {
    log.info(
      `librarian agent threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  } finally {
    ctx.onAgentEnd?.();
  }

  if (runResult.stoppedReason === 'error') {
    log.info(
      `librarian reported error: ${runResult.error ?? '(no message)'}`
    );
    return 'error';
  }

  // Reasoning is the agent's brief operator-facing summary of what
  // it merged / deleted / left alone (see the "Final reply" block in
  // ../wiki-librarian/prompt.ts). Normalise whitespace so a multi-
  // line reply still fits on one log line, and fall back to a
  // sentinel when the model returned empty (shouldn't happen in
  // production but better surfaced as "(none)" than a dangling
  // `reasoning=""`).
  const reasoning =
    runResult.output.finalText.replace(/\s+/g, ' ').trim() || '(none)';
  log.info(
    `librarian finished (${runResult.toolCalls} tool calls over ` +
      `${runResult.output.articleCount} articles, reasoning="${reasoning}")`
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
