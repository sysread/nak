// priming ---------------------------------------------------------------------
//
// Server-side turn-entry priming. The browser used to run priming
// before POSTing /stream (src/lib/chat/preturn-priming.ts); it now runs
// here as the opening stage of getStreamingResponse, under the same
// EdgeRuntime.waitUntil that keeps streaming alive across browser
// disconnect, so "come back to a finished answer" holds for the whole
// turn rather than just the streaming half.
//
// This file is being built one pipeline at a time (see the plan in the
// branch description). Bias is first: it is a system-prompt appendix
// rather than a <think> row and carries no per-turn UI wire event, so
// it is the smallest complete slice. Intuition, context-recall, and
// samskara follow.
//
// Admin-client scoping: the orchestrator holds a service-role client
// with no auth.uid(), so every read/write here scopes by the explicit
// opts.userId rather than leaning on RLS.
import { type SupabaseClient } from '@supabase/supabase-js';
import { isBiasKey } from '../_shared/bias-catalog.ts';
import {
  type BiasSummaryRow,
  formatBiasProfileBlock,
  pickRenderable,
} from '../_shared/bias-format.ts';
import { type EdgeLogger } from '../_shared/edge-log.ts';

// Minimal structural shape of a wire message the priming step mutates.
// Matches getStreamingResponse's local VeniceMessage without importing
// its private interface.
interface PrimingMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
}

export interface BiasPrimingOpts {
  adminClient: SupabaseClient;
  userId: string;
  threadId: string;
  /** Mutated in place: the bias block is appended to the row-0 system
   *  message when present. */
  history: PrimingMessage[];
  log: EdgeLogger;
}

/**
 * Read the user's cached bias aggregates, render the "observed
 * cognitive patterns" block, append it to the baseline system prompt,
 * and fire the two best-effort bias-sweep writes (active-set snapshot
 * and new-user-message clear).
 *
 * Swallow contract mirrors the browser's getBiasProfileBlock /
 * snapshotBiasActiveBiases / notifyBiasNewUserMessage: bias plumbing
 * never throws and never fails a turn. A read failure or cold-start
 * cache leaves the system prompt unchanged.
 */
export async function applyBiasPriming(opts: BiasPrimingOpts): Promise<void> {
  const { adminClient, userId, threadId, history, log } = opts;

  let rows: BiasSummaryRow[];
  try {
    rows = await readBiasSummary(adminClient, userId);
  } catch (err) {
    log.debug('bias priming: summary read failed', err);
    rows = [];
  }

  const block = formatBiasProfileBlock(rows);
  // activeBiases is the set that actually rendered (post tier filter,
  // post render cap) - the same rule the formatter applies internally,
  // lifted out here so the snapshot write below records exactly what
  // landed in the prompt. Empty when nothing cleared soft.
  const activeBiases = pickRenderable(rows).map((r) => r.bias);

  if (block && block.length > 0) {
    // Bias rides at the end of the baseline system prompt (row 0),
    // joined with the same blank-line separator buildSystemPrompt uses,
    // so the wire bytes match what the browser used to bake in. The
    // trailing metadata system row is a SEPARATE message at the tail of
    // history; the bias block must not land there.
    const systemRow = history[0];
    if (systemRow && systemRow.role === 'system') {
      const base = systemRow.content ?? '';
      systemRow.content = base.length > 0 ? `${base}\n\n${block}` : block;
    } else {
      // Defensive: the browser always ships a role:system message
      // first. If that ever changes, skip injection rather than
      // corrupt an unexpected row - the turn proceeds unprimed.
      log.debug('bias priming: no leading system row; skipped injection');
    }
  }

  // Snapshot the active set so the bias sweep's reactor pass knows
  // which biases the user's messages this turn could have been
  // reacting to. Empty array is a valid write ("no compensation
  // active"). Detached + swallowed - never blocks or fails the turn.
  void snapshotBiasActiveBiases(adminClient, threadId, userId, activeBiases).catch(
    (err) => log.debug('bias priming: snapshot failed', err),
  );

  // Each turn is one new user message on this thread; clear the sweep's
  // processed state so a previously-analyzed thread gets re-observed
  // against the fresh conversation. No-op when never processed.
  // Detached + swallowed.
  void clearBiasThread(adminClient, threadId, userId).catch((err) =>
    log.debug('bias priming: clear thread failed', err),
  );
}

/**
 * Read every cached aggregate for the user from bias_summary, scoped
 * by explicit user_id (admin client has no auth.uid()). Unknown-key
 * rows are dropped - a key not in the catalog means the catalog was
 * edited but the cache is stale; safer to skip than to render an entry
 * whose guidance we cannot resolve. Mirrors the browser's
 * biasListSummary + getBiasProfileBlock row coercion.
 */
async function readBiasSummary(
  adminClient: SupabaseClient,
  userId: string,
): Promise<BiasSummaryRow[]> {
  const { data, error } = await adminClient
    .from('bias_summary')
    .select(
      'bias, effective_n, posterior_alpha, posterior_beta, posterior_mean, ci_lower, feedback_score, tier, computed_at',
    )
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  const raw = (data ?? []) as Array<{
    bias: string;
    effective_n: number;
    posterior_alpha: number;
    posterior_beta: number;
    posterior_mean: number;
    ci_lower: number;
    feedback_score: number | null;
    tier: 'elided' | 'soft' | 'strong';
    computed_at: string;
  }>;
  const rows: BiasSummaryRow[] = [];
  for (const r of raw) {
    if (!isBiasKey(r.bias)) continue;
    rows.push({
      bias: r.bias,
      effectiveN: r.effective_n,
      posteriorAlpha: r.posterior_alpha,
      posteriorBeta: r.posterior_beta,
      posteriorMean: r.posterior_mean,
      ciLower: r.ci_lower,
      // feedback_score was added in v2; pre-v2 rows return null which
      // we treat as the neutral 0.
      feedbackScore: r.feedback_score ?? 0,
      tier: r.tier,
      computedAt: r.computed_at,
    });
  }
  return rows;
}

/**
 * Persist the rendered bias keys into threads.bias_active_at_turn,
 * scoped by user_id (admin client). Mirrors the browser's
 * biasSnapshotActiveBiases UPDATE.
 */
async function snapshotBiasActiveBiases(
  adminClient: SupabaseClient,
  threadId: string,
  userId: string,
  biases: readonly string[],
): Promise<void> {
  const { error } = await adminClient
    .from('threads')
    .update({ bias_active_at_turn: Array.from(biases) })
    .eq('id', threadId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/**
 * Clear the sweep's processed state for a thread on a new user
 * message. Mirrors the browser's notifyBiasNewUserMessage; passes
 * p_user_id because the admin client has no auth.uid() for the RPC's
 * internal ownership scoping.
 */
async function clearBiasThread(
  adminClient: SupabaseClient,
  threadId: string,
  userId: string,
): Promise<void> {
  const { error } = await adminClient.rpc('bias_clear_thread', {
    p_thread_id: threadId,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
}
