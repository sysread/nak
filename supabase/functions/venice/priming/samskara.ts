// The samskara turn-entry priming IO half: getCompoundSummary +
// fireSamskaras, run inside the venice edge function so pre-turn priming
// rides the durable streaming function rather than the browser. This is
// the canonical implementation (extracted from the browser during the
// priming relocation). The pure formatter and the tunables live in
// ./samskara-format.ts; this file owns the Supabase + Venice IO.
//
// Adjacent server-side modules this leans on:
//   - ../../_shared/venice.ts        veniceEmbed (POST /embeddings)
//   - ../../_shared/backfill.ts      VENICE_EMBEDDING_MODEL + the
//                                    zero-extension padding helper
//   - ../../_shared/edge-log.ts      the drawer-mirroring EdgeLogger
//
// Both exports return null on ANY failure and never throw, because a
// priming failure must never fail the user's chat turn. The orchestrator
// continues with no compound block / no fire appendix when either
// returns null.
//
// Two service-side specifics:
//   - The service-role admin client has no auth.uid(), so both RPCs are
//     called with the explicit p_user_id the orchestrator passes
//     through (the b-strict overload the schema added).
//   - Embedding goes through veniceEmbed with the shared key.

import { type SupabaseClient } from '@supabase/supabase-js';
import { type EdgeLogger } from '../../_shared/edge-log.ts';
import { veniceEmbed } from '../../_shared/venice.ts';
import {
  padEmbeddingForStorage,
  VENICE_EMBEDDING_MODEL,
} from '../../_shared/backfill.ts';
import {
  FIRE_SCORE_FLOOR,
  type FireResult,
  K_BASE,
  STALE_CEILING_HOURS,
  topKForCorpusSize,
} from './samskara-format.ts';

/**
 * Read the cached compound summary. Returns null when the row is
 * absent (cold start), the summary string is empty, or the cache is
 * older than `STALE_CEILING_HOURS`. The orchestrator treats null as
 * "no compound block this turn"; the formatter renders only the fire
 * section if any.
 *
 * Swallows fetch/RPC failures by contract: supabase-js re-throws the
 * raw fetch TypeError when the network blips, which without this guard
 * would bubble up through the orchestrator's priming block and fail the
 * turn. Samskara helpers never fail a turn.
 */
export async function getCompoundSummary(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<string | null> {
  let row: {
    summary: string | null;
    last_regen_at: string | null;
    samskara_count_at_regen: number | null;
  } | null;
  try {
    const { data, error } = await admin
      .from('samskara_compound_summary')
      .select('summary, last_regen_at, samskara_count_at_regen')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    row = (data ?? null) as typeof row;
  } catch (err) {
    log.debug('compound summary read failed', err);
    return null;
  }
  if (!row || !row.summary || row.summary.length === 0) {
    log.debug('compound summary: empty (cold start)');
    return null;
  }
  if (row.last_regen_at) {
    const ageMs = Date.now() - new Date(row.last_regen_at).getTime();
    if (ageMs > STALE_CEILING_HOURS * 60 * 60 * 1000) {
      log.debug('compound summary: stale, ignoring', {
        ageHours: Math.round(ageMs / 3_600_000),
        ceilingHours: STALE_CEILING_HOURS,
      });
      return null;
    }
  }
  log.debug('compound summary: loaded', { chars: row.summary.length });
  return row.summary;
}

/** Row shape returned by the `samskara_fire_top_k` RPC (snake_case wire shape). */
interface FireRow {
  id: string;
  prediction: string;
  inner_voice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
  score: number;
}

/**
 * Embed the user's text, run the cosine fire RPC, and persist the
 * cohort. Returns null when there are no samskaras yet or the user
 * text is empty - the orchestrator renders priming without a fire
 * section in either case.
 *
 * Cohort id: generated here as a uuid via crypto.randomUUID and
 * written into every fire row in the same RPC. The reaction classifier
 * in the formation pipeline uses cohort_id to score the set as a unit
 * (cohort-aware reinforcement weighting) and to mark the entire cohort
 * resolved in one update.
 *
 * Errors are swallowed and logged: a fire failure should NOT block the
 * user's chat turn. The orchestrator continues with no priming appendix
 * from this fire if anything goes wrong.
 */
export async function fireSamskaras(opts: {
  admin: SupabaseClient;
  userId: string;
  apiKey: string;
  threadId: string;
  userRound: number;
  userText: string;
  signal?: AbortSignal;
  log: EdgeLogger;
}): Promise<FireResult | null> {
  const { admin, userId, apiKey, threadId, userRound, userText, signal, log } =
    opts;

  const trimmed = userText.trim();
  if (trimmed.length === 0) {
    log.debug('fire: empty user text, skipping');
    return null;
  }

  log.debug('fire: embedding user text', { chars: trimmed.length });
  let rawEmbedding: number[] | undefined;
  try {
    const resp = await veniceEmbed({
      apiKey,
      model: VENICE_EMBEDDING_MODEL,
      input: trimmed,
      signal,
    });
    rawEmbedding = resp.data[0]?.embedding;
  } catch (err) {
    log.debug('fire embed failed', err);
    return null;
  }
  if (!rawEmbedding || rawEmbedding.length === 0) {
    log.debug('fire: embed returned empty vector');
    return null;
  }

  // Pad for query - pgvector requires the query embedding to match
  // the column dim exactly. Same helper memories use; cosine is
  // invariant to the zero-extension.
  const padded = padEmbeddingForStorage(rawEmbedding);

  // Top-k: log10-dampened. We don't know the true corpus size at
  // this layer without an extra round trip, so we ask for a generous
  // 25 (K_BASE=5, log10(100+10) ~= 2.04, ceil = 11 - bump to 25
  // because the long tail is what the design is built around). The
  // RPC returns at most that many; the formatter trims by token
  // budget, not by row count.
  const kMax = topKForCorpusSize(100, K_BASE) * 2;

  let rows: FireRow[] | null;
  try {
    const { data, error } = await admin.rpc('samskara_fire_top_k', {
      p_query_embedding: padded,
      p_k_max: kMax,
      p_user_id: userId,
    });
    if (error) throw new Error(error.message);
    rows = (data ?? []) as FireRow[];
  } catch (err) {
    log.debug('fire RPC failed', err);
    return null;
  }
  if (!rows || rows.length === 0) {
    log.debug('fire: top-k returned 0 rows (corpus empty or no matches)');
    return null;
  }

  // Drop effectively-retired (health~0, score~0) samskaras before they
  // join the cohort. The fire RPC has no health threshold by design -
  // it returns the long tail ordered by score - but a row scoring ~0
  // adds nothing to priming while still inflating cohort size,
  // fire_count, and co-fire noise. See FIRE_SCORE_FLOOR.
  const live = rows.filter((r) => r.score >= FIRE_SCORE_FLOOR);
  if (live.length === 0) {
    log.debug('fire: all top-k rows below score floor (corpus is dormant)');
    return null;
  }

  const cohortId = crypto.randomUUID();
  const fired = live.map((r) => ({
    id: r.id,
    prediction: r.prediction,
    innerVoice: r.inner_voice,
    valence: r.valence,
    confidence: r.confidence,
    health: r.health,
    score: r.score,
  }));
  log.info('fire: cohort formed', {
    cohortId,
    threadId,
    size: fired.length,
    topScore: fired[0]?.score,
  });

  // Persist the cohort. Errors here are logged but not surfaced - the
  // priming block still renders even if the fire log write failed (the
  // next reaction-classify pass simply has no cohort to score). Better
  // than failing the user-visible chat turn.
  try {
    const { error } = await admin.rpc('samskara_record_fires', {
      p_cohort_id: cohortId,
      p_thread_id: threadId,
      p_user_round: userRound,
      p_fires: fired.map((f) => ({ samskara_id: f.id, score: f.score })),
      p_user_id: userId,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    log.debug('fire log write failed', err);
  }

  return { cohortId, fired };
}
