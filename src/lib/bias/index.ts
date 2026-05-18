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
import { isBiasKey, type BiasKey } from './catalog';
import { formatBiasProfileBlock, pickRenderable } from './format';
import type { BiasSummaryRow, Tier } from './types';
import { createLogger } from '../logger.svelte';

const log = createLogger('bias');

export { formatBiasProfileBlock } from './format';
export type { BiasSummaryRow, Tier } from './types';

/**
 * What `getBiasProfileBlock` resolves with. The string is what
 * rides in the system prompt; `activeBiases` is the catalog-key
 * list of biases that actually rendered (post render-cap) so the
 * chat-loop can snapshot the set into threads.bias_active_at_turn
 * for the worker's reactor pass to read later. The two come from
 * one bias_summary read so they cannot drift.
 */
export interface BiasProfileResult {
  block: string | null;
  activeBiases: BiasKey[];
}

/**
 * Build the system-prompt block from the cached bias_summary.
 * Returns `{ block: null, activeBiases: [] }` when:
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
): Promise<BiasProfileResult> {
  let raw;
  try {
    raw = await supabase.biasListSummary();
  } catch (err) {
    log.debug('bias profile read failed', err);
    return { block: null, activeBiases: [] };
  }
  if (!raw || raw.length === 0) {
    log.debug('bias profile: empty cache (cold start)');
    return { block: null, activeBiases: [] };
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
      feedbackScore: r.feedbackScore,
      tier: r.tier as Tier,
      computedAt: r.computedAt,
    });
  }
  const block = formatBiasProfileBlock(rows);
  // Same rule the formatter applies internally; lifted out here so
  // the chat-loop snapshot writer sees the exact set that just
  // rendered (post tier filter, post render cap). If the formatter
  // returns null these are the rows that fell short of soft - the
  // snapshot is the empty set.
  const activeBiases = pickRenderable(rows).map((r) => r.bias);
  return { block, activeBiases };
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

/**
 * Snapshot the set of bias keys that just rendered into the system
 * prompt to threads.bias_active_at_turn. The worker reads this
 * snapshot when claiming the thread for analysis so the merged
 * observer/reactor agent knows which biases the user's messages
 * could have been reacting to. Best-effort; errors swallowed so a
 * failed snapshot does not fail the chat turn - the worker will
 * see whatever the previous turn wrote (or an empty set on a
 * fresh thread), which just means "no reactions to classify" -
 * the feedback EMA stays at 0 and tier thresholds stay at the v1
 * defaults.
 */
export async function snapshotBiasActiveBiases(
  supabase: SupabaseService,
  threadId: string,
  activeBiases: readonly string[]
): Promise<void> {
  try {
    await supabase.biasSnapshotActiveBiases(threadId, activeBiases);
    log.debug('bias profile: snapshot active biases', {
      threadId,
      count: activeBiases.length,
    });
  } catch (err) {
    log.debug('bias profile: snapshot failed', err);
  }
}
