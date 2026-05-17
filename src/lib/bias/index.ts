/**
 * Public surface for the bias-profile feature on the chat-loop side.
 *
 * The chat loop has two integration points and they both live behind
 * this module:
 *
 *   - `getBiasProfileBlock(supabase)` - read the cached bias_summary
 *     rows at turn entry, take the soft+strong subset, render the
 *     "User profile - observed patterns" block. Returns null on
 *     cold start (no observations yet) or when no row clears the
 *     elided tier; the caller (buildSystemPrompt) omits the
 *     section entirely rather than rendering a placeholder.
 *
 *   - `notifyBiasNewUserMessage(supabase, threadId)` - fire-and-
 *     forget call after a user message inserts on a previously-
 *     processed thread. The RPC deletes the thread's existing
 *     bias_observations and clears bias_processed_at so the worker
 *     picks the thread up again with the fresh state. The
 *     aggregate cache stays as-is; the worker's next aggregate
 *     pass catches up.
 *
 * Plus `formatBiasProfileBlock` re-exported from `./format` for
 * tests and the debug modal. The module is deliberately small:
 * the math kernel, the worker, and the agent are under
 * `src/lib/bias/math.ts` and `src/lib/agents/bias/` respectively.
 */
import type { SupabaseService } from '../supabase';
import { isBiasKey } from './catalog';
import { formatBiasProfileBlock } from './format';
import type { BiasSummaryRow, Tier } from './types';
import { createLogger } from '../logger.svelte';

const log = createLogger('bias');

export { formatBiasProfileBlock } from './format';
export type { BiasSummaryRow, Tier } from './types';

/**
 * Build the system-prompt block from the cached bias_summary.
 * Returns null when:
 *   - the read fails (network blip, RLS rejection) - errors are
 *     swallowed; bias is silent, so a missing block is the right
 *     fallback
 *   - no row clears the elided tier
 *
 * Swallow contract mirrors samskara's `getCompoundSummary`: this
 * helper never throws and never fails a chat turn.
 */
export async function getBiasProfileBlock(
  supabase: SupabaseService
): Promise<string | null> {
  let raw;
  try {
    raw = await supabase.biasListSummary();
  } catch (err) {
    log.debug('bias profile read failed', err);
    return null;
  }
  if (!raw || raw.length === 0) {
    log.debug('bias profile: empty cache (cold start)');
    return null;
  }
  // Filter to known-catalog rows. An unknown `bias` key in the
  // cache would mean the catalog was edited but the cache is
  // stale; safer to silently drop than to render an entry whose
  // guidance string we cannot resolve.
  const rows: BiasSummaryRow[] = [];
  for (const r of raw) {
    if (!isBiasKey(r.bias)) continue;
    rows.push({
      bias: r.bias,
      effectiveN: r.effectiveN,
      posteriorAlpha: r.posteriorAlpha,
      posteriorBeta: r.posteriorBeta,
      posteriorMean: r.posteriorMean,
      ciLower: r.ciLower,
      tier: r.tier as Tier,
      computedAt: r.computedAt,
    });
  }
  return formatBiasProfileBlock(rows);
}

/**
 * Clear the worker's processed state on a thread after a new user
 * message lands. Best-effort; swallows errors so a failed clear
 * does not fail the chat turn. The worker's next scan picks the
 * thread up because its bias_processed_at is null (or older than
 * threads.updated_at, which the message insert just bumped).
 */
export async function notifyBiasNewUserMessage(
  supabase: SupabaseService,
  threadId: string
): Promise<void> {
  try {
    await supabase.biasClearThread(threadId);
    log.debug('bias profile: cleared thread on new user message', { threadId });
  } catch (err) {
    log.debug('bias profile: clear thread failed', err);
  }
}
