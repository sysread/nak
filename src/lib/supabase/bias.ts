/**
 * Bias-profile domain slice of the Supabase data layer: the cached
 * bias_summary aggregates the chat loop renders from, plus the debug
 * modal's drill-down reads over bias_observations, bias_reactions,
 * and the threads.bias_processed_at marker.
 *
 * The per-turn bias writes (active-set snapshot + new-message clear)
 * moved server-side when priming relocated into the venice edge
 * function (supabase/functions/venice/priming.ts), so this slice is
 * read-only - the browser never writes bias rows.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its bias methods
 * here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';

/**
 * Chat-loop: read every cached aggregate for the user. Returns
 * empty array on cold-start (no row in bias_summary yet) or on
 * any RPC error - the format pass treats both as "no bias block
 * this turn", matching samskara's null-on-empty contract.
 */
export async function biasListSummary(client: SupabaseClient): Promise<
  {
    bias: string;
    effectiveN: number;
    posteriorAlpha: number;
    posteriorBeta: number;
    posteriorMean: number;
    ciLower: number;
    feedbackScore: number;
    tier: 'elided' | 'soft' | 'strong';
    computedAt: string;
  }[]
> {
  const { data, error } = await client
    .from('bias_summary')
    .select(
      'bias, effective_n, posterior_alpha, posterior_beta, posterior_mean, ci_lower, feedback_score, tier, computed_at'
    );
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as {
    bias: string;
    effective_n: number;
    posterior_alpha: number;
    posterior_beta: number;
    posterior_mean: number;
    ci_lower: number;
    feedback_score: number | null;
    tier: 'elided' | 'soft' | 'strong';
    computed_at: string;
  }[];
  return rows.map((r) => ({
    bias: r.bias,
    effectiveN: r.effective_n,
    posteriorAlpha: r.posterior_alpha,
    posteriorBeta: r.posterior_beta,
    posteriorMean: r.posterior_mean,
    ciLower: r.ci_lower,
    // feedback_score column was added in v2; pre-v2 rows return
    // null which we treat as the neutral 0.
    feedbackScore: r.feedback_score ?? 0,
    tier: r.tier,
    computedAt: r.computed_at,
  }));
}

/**
 * Debug modal: per-bias raw observation counts across the user's
 * full history. Distinct from `effective_n` on the summary row -
 * effective_n is the recency-weighted sum of ALL processed
 * conversations (including the pConv=0 "no-hit" denominator), so
 * every catalog entry the worker has touched ends up with a
 * non-zero effective_n even when it was never flagged. The
 * observation count answers the user's question "has anything
 * ever been recorded against this bias for me?" - zero means the
 * row's posterior is just the prior plus the cumulative no-hit
 * mass, and the modal renders it as "no evidence" rather than
 * the ~5% prior 10th-percentile.
 *
 * Aggregation is client-side. The bias_observations table has no
 * native group-by in the PostgREST surface, and observation
 * counts are small enough (worker-rate-limited, bounded by the
 * catalog size times processed conversations) that pulling the
 * `bias` column and tallying in JS is cheaper than adding an
 * RPC for it.
 */
export async function biasListObservationCounts(
  client: SupabaseClient
): Promise<Record<string, number>> {
  const { data, error } = await client
    .from('bias_observations')
    .select('bias');
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as { bias: string }[];
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.bias] = (counts[r.bias] ?? 0) + 1;
  }
  return counts;
}

/**
 * Debug modal: list per-conversation reactions for one thread.
 * The current-conversation section uses this to surface "did the
 * user affirm or push back on the compensation for X here?"
 * alongside the observations for the same thread.
 */
export async function biasListReactionsForThread(
  client: SupabaseClient,
  threadId: string
): Promise<
  {
    id: string;
    bias: string;
    wasConfirmed: boolean | null;
    reasoning: string;
    createdAt: string;
  }[]
> {
  const { data, error } = await client
    .from('bias_reactions')
    .select('id, bias, was_confirmed, reasoning, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as {
    id: string;
    bias: string;
    was_confirmed: boolean | null;
    reasoning: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    bias: r.bias,
    wasConfirmed: r.was_confirmed,
    reasoning: r.reasoning,
    createdAt: r.created_at,
  }));
}

/**
 * Debug modal: fetch a thread's bias_processed_at timestamp.
 * Returns null if the thread row doesn't exist yet (e.g. a brand-
 * new draft conversation that hasn't been materialized to the DB)
 * or if the worker hasn't analyzed it yet. The bias-profile modal
 * uses this to distinguish "not yet analyzed" (no observations
 * because the worker hasn't gotten to it) from "already analyzed,
 * no findings" (no observations because the worker scanned and
 * came up empty) - otherwise a fresh conversation reads as the
 * latter, which is wrong and misleading.
 */
export async function biasGetThreadProcessedAt(
  client: SupabaseClient,
  threadId: string
): Promise<string | null> {
  const { data, error } = await client
    .from('threads')
    .select('bias_processed_at')
    .eq('id', threadId)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  const row = data as { bias_processed_at: string | null } | null;
  return row?.bias_processed_at ?? null;
}

/**
 * Debug modal: list observations for one thread. Used by the
 * per-conversation drill-down. Includes the cited message id so
 * the modal can deep-link back to the original.
 */
export async function biasListObservationsForThread(
  client: SupabaseClient,
  threadId: string
): Promise<
  {
    id: string;
    bias: string;
    confidence: number;
    reasoning: string;
    evidenceMessageId: string | null;
    createdAt: string;
  }[]
> {
  const { data, error } = await client
    .from('bias_observations')
    .select('id, bias, confidence, reasoning, evidence_message_id, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as {
    id: string;
    bias: string;
    confidence: number;
    reasoning: string;
    evidence_message_id: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    bias: r.bias,
    confidence: r.confidence,
    reasoning: r.reasoning,
    evidenceMessageId: r.evidence_message_id,
    createdAt: r.created_at,
  }));
}

/**
 * Debug modal: list every observation for one bias key across
 * every thread the user has, joined to the source thread's
 * title so each row can render as a navigable link. Drives the
 * per-bias drill-down ("which conversations triggered this?")
 * on the bias-profile screen.
 *
 * Sorted newest-first - the user's mental model is "what got
 * flagged recently for this bias?", not chronological reading
 * order. RLS scopes the read to the current user; deleted
 * threads have already cascaded their observations away, so a
 * missing thread title here means the auto-titler hasn't run
 * yet, not a dangling reference.
 */
export async function biasListObservationsForBiasKey(
  client: SupabaseClient,
  biasKey: string
): Promise<
  {
    id: string;
    threadId: string;
    threadTitle: string | null;
    confidence: number;
    reasoning: string;
    createdAt: string;
  }[]
> {
  const { data, error } = await client
    .from('bias_observations')
    .select('id, thread_id, confidence, reasoning, created_at, threads(title)')
    .eq('bias', biasKey)
    .order('created_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  const out: {
    id: string;
    threadId: string;
    threadTitle: string | null;
    confidence: number;
    reasoning: string;
    createdAt: string;
  }[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = row.id;
    const threadId = row.thread_id;
    if (typeof id !== 'string' || typeof threadId !== 'string') continue;
    // PostgREST returns a many-to-one embed as a single object,
    // but the supabase-js type inference treats it as either an
    // object or array depending on FK metadata. Mirror the
    // unwrap pattern from listWikiArticleSources so this stays
    // robust against either shape.
    const thread = row.threads as { title?: unknown } | { title?: unknown }[] | null;
    const threadObj = Array.isArray(thread) ? thread[0] : thread;
    const title =
      threadObj && typeof threadObj.title === 'string' ? threadObj.title : null;
    out.push({
      id,
      threadId,
      threadTitle: title,
      confidence: typeof row.confidence === 'number' ? row.confidence : 0,
      reasoning: typeof row.reasoning === 'string' ? row.reasoning : '',
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    });
  }
  return out;
}

/**
 * Debug modal: list the most-recently-processed threads with
 * counts of observations and the message-count token. Drives the
 * "Processed conversations" table on the bias-profile screen.
 */
export async function biasListProcessedThreads(
  client: SupabaseClient,
  limit: number = 30
): Promise<
  {
    threadId: string;
    title: string;
    processedAt: string;
    observationCount: number;
  }[]
> {
  const { data, error } = await client
    .from('threads')
    .select(
      'id, title, bias_processed_at, bias_observations(count)'
    )
    // Deleted (hidden) threads are invisible to every list surface,
    // the debug modal included.
    .eq('hidden', false)
    .not('bias_processed_at', 'is', null)
    .order('bias_processed_at', { ascending: false })
    .limit(limit);
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as {
    id: string;
    title: string | null;
    bias_processed_at: string;
    // Supabase's `embedded count` returns an array containing
    // one row with { count: N }; the cast is fragile in the
    // type system, careful at the boundary.
    bias_observations: { count: number }[] | null;
  }[];
  return rows.map((r) => ({
    threadId: r.id,
    title: r.title ?? '',
    processedAt: r.bias_processed_at,
    observationCount: r.bias_observations?.[0]?.count ?? 0,
  }));
}
