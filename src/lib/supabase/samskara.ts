/**
 * Samskara domain slice of the Supabase data layer: the substrate-stub
 * write, the compound-summary read, the diagnostics reads behind the
 * inline CohortPanel and the mood pill, and the observability reads
 * behind the Corpus + Health panels.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its samskara
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types live in ./types/samskara.ts.
 *
 * Everything here is a thin wrapper over the SQL functions and tables
 * defined in the samskara section of supabase/schema.sql; the SQL owns
 * the RLS-aware bookkeeping (cohort weighting, the confidence formula)
 * and these functions just shape arguments and unwrap responses. Only
 * the client-side substrate write and the diagnostics reads live
 * browser-side - the formation pipeline (claim / assimilate / mint /
 * dedup / compound-regen) and the pre-turn priming reads run
 * server-side in supabase/functions/venice/agents/samskara.ts against
 * the same SQL surface via its p_user_id overloads.
 * (samskaraGetCompoundSummary survives here only as a diagnostics
 * read - see SamskaraHealthPanel.)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import type { OffsetPage } from './types/core';
import type {
  SamskaraBrowseSort,
  SamskaraCorpusRow,
  SamskaraProvenanceRow,
  SamskaraHealthSnapshot,
  SamskaraRates,
  SamskaraVerdictCounts,
  SamskaraSubstrateDiagnosticRow,
  SamskaraFireDiagnosticRow,
} from './types/samskara';

/** Snake-case shape of a corpus row as it arrives from a select or RPC. */
interface SamskaraCorpusRpcRow {
  id: string;
  tier: number;
  prediction: string;
  inner_voice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
  fire_count: number;
  confirm_count: number;
  disconfirm_count: number;
  last_fired_at: string | null;
  created_at: string;
  cosine?: number;
}

/** Map a snake-case corpus row (select or RPC) to the camelCase UI shape. */
function mapSamskaraCorpusRow(r: SamskaraCorpusRpcRow): SamskaraCorpusRow {
  return {
    id: r.id,
    tier: r.tier,
    prediction: r.prediction,
    innerVoice: r.inner_voice,
    valence: r.valence,
    confidence: r.confidence,
    health: r.health,
    fireCount: r.fire_count,
    confirmCount: r.confirm_count,
    disconfirmCount: r.disconfirm_count,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    ...(typeof r.cosine === 'number' ? { cosine: r.cosine } : {}),
  };
}

/**
 * Insert the per-round substrate stub. The chat loop calls this at
 * end-of-round with the just-persisted message ids; the assimilator
 * worker phase fills in `situation`/`outcome`/`valence` later.
 */
export async function samskaraRecordSubstrate(
  client: SupabaseClient,
  threadId: string,
  userMessageId: string,
  assistantMessageId: string | null
): Promise<string> {
  const { data, error } = await client.rpc('samskara_record_substrate', {
    p_thread_id: threadId,
    p_user_message_id: userMessageId,
    p_assistant_message_id: assistantMessageId,
  });
  if (error) throw new SupabaseError(error.message);
  return data as string;
}

/**
 * Read the cached compound summary row. NULL summary or absent row
 * is the cold-start case; chat-loop reader treats both as "no
 * compound block this turn." The caller decides any staleness
 * ceiling on `lastRegenAt` — kept here for future use.
 */
export async function samskaraGetCompoundSummary(client: SupabaseClient): Promise<{
  summary: string | null;
  lastRegenAt: string | null;
  samskaraCountAtRegen: number;
} | null> {
  // samskara_count_at_regen is purely a diagnostics hook — the
  // getter the chat loop uses discards it, but the Samskara
  // diagnostics screen wants to show "summary covers N samskaras".
  // Cheap to return regardless; no reason to fork into two methods.
  const { data, error } = await client
    .from('samskara_compound_summary')
    .select('summary, last_regen_at, samskara_count_at_regen')
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  if (!data) return null;
  const row = data as {
    summary: string | null;
    last_regen_at: string | null;
    samskara_count_at_regen: number | null;
  };
  return {
    summary: row.summary,
    lastRegenAt: row.last_regen_at,
    samskaraCountAtRegen: row.samskara_count_at_regen ?? 0,
  };
}

// Diagnostics reads --------------------------------------------------
//
// These power the inline CohortPanel in the chat transcript and the
// mood pill's history seed. Pure selects against the user's own rows
// (RLS handles the scoping), safe to call from the main thread. None
// are on the chat-loop hot path; they only run when a human asks to
// see them.

/**
 * All substrate rows anchored to a thread, newest first. Used by the
 * diagnostics screen to narrate which turns the samskara pipeline
 * has seen for this conversation and where each row sits in the
 * assimilate -> embed lifecycle. Embedding column deliberately
 * omitted (2048 floats per row x N rows is a lot of wire traffic
 * for a human-readable panel).
 */
export async function samskaraListSubstrateForThread(
  client: SupabaseClient,
  threadId: string
): Promise<SamskaraSubstrateDiagnosticRow[]> {
  const { data, error } = await client
    .from('samskara_substrate')
    .select(
      'id, user_message_id, assistant_message_id, situation, outcome, valence, embedding_model, created_at'
    )
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as {
    id: string;
    user_message_id: string;
    assistant_message_id: string | null;
    situation: string | null;
    outcome: string | null;
    valence: number | null;
    embedding_model: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    userMessageId: r.user_message_id,
    assistantMessageId: r.assistant_message_id,
    situation: r.situation,
    outcome: r.outcome,
    valence: r.valence,
    embeddingModel: r.embedding_model,
    createdAt: r.created_at,
  }));
}

/**
 * Most recent fire's valence + tier + confidence for a thread, used
 * to seed the mood pill on conversation reopen so the user doesn't
 * have to wait for a fresh mint to see anything other than 💤.
 * Filters out fires whose joined samskara has a null valence (rare,
 * but the field is nullable until the assimilator lands a reading)
 * - returning null lets the caller fall back to the default
 * placeholder cleanly. Confidence falls back to 1 when the column
 * is null on legacy rows so the seed renders the confident column;
 * the alternative (rendering tentative for "unknown") would be a
 * worse default. `.limit(1)` keeps this cheap on threads with
 * hundreds of fires.
 */
export async function samskaraGetLatestFireMood(
  client: SupabaseClient,
  threadId: string
): Promise<{ valence: number; tier: 1 | 2; confidence: number } | null> {
  // `samskaras!inner` collapses fires whose FK target was deleted
  // out of the result at the DB level, and the
  // `.not('samskaras.valence', 'is', null)` filter additionally
  // skips fires whose joined samskara hasn't had a valence
  // assimilated yet. Without the !inner, an orphaned fire could
  // come back with samskaras=null and burn the `.limit(1)` slot,
  // hiding a perfectly good fire one row below.
  const { data, error } = await client
    .from('samskara_fires')
    .select('samskaras!inner(valence, tier, confidence)')
    .eq('thread_id', threadId)
    .not('samskaras.valence', 'is', null)
    .order('fired_at', { ascending: false })
    .limit(1);
  if (error) throw new SupabaseError(error.message);
  interface EmbeddedMood {
    valence: number | null;
    tier: number;
    confidence: number | null;
  }
  const rows = (data ?? []) as unknown as {
    samskaras: EmbeddedMood | EmbeddedMood[] | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  // supabase-js types the embed as an array even for N:1; runtime
  // is a single object when the FK resolves. Same shape-quirk
  // handled in samskaraListFiresForThread below.
  const joined = Array.isArray(row.samskaras)
    ? (row.samskaras[0] ?? null)
    : row.samskaras;
  if (!joined || joined.valence === null) return null;
  // Collapse any unexpected tier value to tier 1 so the consumer's
  // narrow union doesn't drift.
  const tier: 1 | 2 = joined.tier === 2 ? 2 : 1;
  return {
    valence: joined.valence,
    tier,
    confidence: joined.confidence ?? 1,
  };
}

/**
 * All fires anchored to a thread, newest first, with the joined
 * samskara payload so the diagnostics screen can render each cohort
 * without a follow-up round trip. Supabase embed syntax pulls the
 * FK'd row under `samskaras`. Grouping by cohort is left to the
 * renderer.
 */
export async function samskaraListFiresForThread(
  client: SupabaseClient,
  threadId: string
): Promise<SamskaraFireDiagnosticRow[]> {
  const { data, error } = await client
    .from('samskara_fires')
    .select(
      'id, cohort_id, samskara_id, score, fired_at, was_confirmed, verdict, user_round, samskaras(tier, prediction, inner_voice, valence, confidence, health)'
    )
    .eq('thread_id', threadId)
    .order('fired_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  // supabase-js types the embed as an array even for N:1 FK'd rows
  // at the type layer — at runtime it's a single object when the
  // relationship resolves to one row. Treat either shape uniformly
  // and pick the first match; null when the FK target was deleted.
  interface EmbeddedSamskara {
    tier: number;
    prediction: string;
    inner_voice: string | null;
    valence: number | null;
    confidence: number;
    health: number;
  }
  const rows = (data ?? []) as unknown as {
    id: string;
    cohort_id: string;
    samskara_id: string;
    score: number;
    fired_at: string;
    was_confirmed: boolean | null;
    verdict: string | null;
    user_round: number | null;
    samskaras: EmbeddedSamskara | EmbeddedSamskara[] | null;
  }[];
  return rows.map((r) => {
    const joined = Array.isArray(r.samskaras)
      ? (r.samskaras[0] ?? null)
      : r.samskaras;
    return {
      id: r.id,
      cohortId: r.cohort_id,
      samskaraId: r.samskara_id,
      score: r.score,
      firedAt: r.fired_at,
      wasConfirmed: r.was_confirmed,
      verdict: r.verdict,
      userRound: r.user_round,
      samskara: joined
        ? {
            tier: joined.tier,
            prediction: joined.prediction,
            innerVoice: joined.inner_voice,
            valence: joined.valence,
            confidence: joined.confidence,
            health: joined.health,
          }
        : null,
    };
  });
}

/**
 * Cluster a thread's fires by cosine similarity on their predictions,
 * scoped per-cohort. Used by the diagnostics modal to collapse a
 * 22-row cohort fire list down to a handful of themes the human
 * reader can scan. Returns the cluster_seq (1-based, restarts per
 * cohort) and cluster_size each fire belongs to; the renderer joins
 * back against the existing fires array by fire id.
 *
 * Threshold default 0.7 sits in BGE-M3's "topically similar" band -
 * paraphrases of the same idea typically land between 0.65 and 0.78.
 * MINT dedup uses 0.85 because that's "near-duplicate sentence";
 * for human-readable theme grouping a lower bar reads as "same idea
 * said differently." Modal exposes the threshold as a slider so the
 * caller can tune it live without a redeploy.
 */
export async function samskaraClusterThreadFires(
  client: SupabaseClient,
  threadId: string,
  threshold = 0.7
): Promise<Map<string, { clusterSeq: number; clusterSize: number }>> {
  const { data, error } = await client.rpc(
    'samskara_cluster_thread_fires',
    { p_thread_id: threadId, p_threshold: threshold }
  );
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as {
    fire_id: string;
    cluster_seq: number;
    cluster_size: number;
  }[];
  const map = new Map<string, { clusterSeq: number; clusterSize: number }>();
  for (const r of rows) {
    map.set(r.fire_id, {
      clusterSeq: r.cluster_seq,
      clusterSize: r.cluster_size,
    });
  }
  return map;
}

// Observability tab reads ----------------------------------------------
//
// Power the Samskara diagnostics tab (Corpus + Health panels). All
// read-only and RLS-scoped; none write or shape anything. See
// docs/dev/samskara.md's observability section.

/**
 * One offset page of the samskara corpus for the Corpus panel's
 * browse list (empty-query regime). `prediction_embedding` is
 * deliberately omitted - 2048 floats x a page of rows is far too fat
 * for a list. Sort maps to a deterministic order; `id` tiebreak keeps
 * cross-page order stable. Optional tier filter.
 */
export async function listSamskarasPage(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
    tier?: number | null;
    sort: SamskaraBrowseSort;
  }
): Promise<OffsetPage<SamskaraCorpusRow>> {
  let q = client
    .from('samskaras')
    .select(
      'id, tier, prediction, inner_voice, valence, confidence, health, fire_count, confirm_count, disconfirm_count, last_fired_at, created_at'
    );
  if (opts.tier != null) q = q.eq('tier', opts.tier);
  // Order columns per sort key. last_fired_at is nullable, so
  // recently-fired pushes never-fired rows to the bottom.
  switch (opts.sort) {
    case 'strongest':
      q = q.order('health', { ascending: false }).order('confidence', { ascending: false });
      break;
    case 'most_fired':
      q = q.order('fire_count', { ascending: false });
      break;
    case 'recently_fired':
      q = q.order('last_fired_at', { ascending: false, nullsFirst: false });
      break;
    case 'recent':
    default:
      q = q.order('created_at', { ascending: false });
      break;
  }
  q = q.order('id', { ascending: false });
  q = q.range(opts.offset, opts.offset + opts.pageSize);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []).map(mapSamskaraCorpusRow);
  const hasMore = rows.length > opts.pageSize;
  return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
}

/**
 * Corpus semantic search: nearest samskaras by cosine on
 * `prediction_embedding`. Plain cosine, NOT the fire-ranking formula -
 * browse wants closest-to-query, not most-likely-to-fire. Optional
 * tier filter. Returns the same shape as the browse list plus a
 * `cosine` relevance score.
 */
export async function searchSamskarasByEmbedding(
  client: SupabaseClient,
  embedding: number[],
  kMax: number,
  tier?: number | null
): Promise<SamskaraCorpusRow[]> {
  const { data, error } = await client.rpc('samskara_search_by_prediction', {
    p_query_embedding: embedding,
    p_k_max: kMax,
    p_tier: tier ?? null,
  });
  if (error) throw new SupabaseError(error.message);
  return ((data ?? []) as SamskaraCorpusRpcRow[]).map(mapSamskaraCorpusRow);
}

/**
 * Substring fallback for corpus search: ILIKE on prediction text.
 * Every samskara is embedded (the column is NOT NULL), so unlike
 * memories there is no disjoint unembedded set - this is purely to
 * surface exact-phrase matches a cosine ranking might bury. Optional
 * tier filter.
 */
export async function searchSamskarasByText(
  client: SupabaseClient,
  query: string,
  limit: number,
  tier?: number | null
): Promise<SamskaraCorpusRow[]> {
  let q = client
    .from('samskaras')
    .select(
      'id, tier, prediction, inner_voice, valence, confidence, health, fire_count, confirm_count, disconfirm_count, last_fired_at, created_at'
    )
    .ilike('prediction', `%${query}%`)
    .order('health', { ascending: false })
    .limit(limit);
  if (tier != null) q = q.eq('tier', tier);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map(mapSamskaraCorpusRow);
}

/**
 * Greedy cosine clustering of the corpus for the "hide similar"
 * slider. Returns a map keyed by samskara id; each entry names the
 * cluster sequence (representative shares the lowest seq) and the
 * cluster's size so the UI can render "+N similar". Optional tier
 * filter must match the list's filter so the assignments line up.
 */
export async function samskaraClusterCorpus(
  client: SupabaseClient,
  threshold: number,
  tier?: number | null
): Promise<Map<string, { seq: number; size: number }>> {
  const { data, error } = await client.rpc('samskara_cluster_corpus', {
    p_threshold: threshold,
    p_tier: tier ?? null,
  });
  if (error) throw new SupabaseError(error.message);
  const map = new Map<string, { seq: number; size: number }>();
  for (const r of (data ?? []) as {
    samskara_id: string;
    cluster_seq: number;
    cluster_size: number;
  }[]) {
    map.set(r.samskara_id, { seq: r.cluster_seq, size: r.cluster_size });
  }
  return map;
}

/**
 * Resolve a samskara's provenance to labelled rows for the detail
 * view. For a tier-2 compound these are its tier-1 children (label =
 * child prediction); for a tier-1 they're substrate situations and
 * association labels. A null label means the target was deleted since
 * minting - the UI renders that as "(removed)".
 */
export async function samskaraProvenanceDetail(
  client: SupabaseClient,
  samskaraId: string
): Promise<SamskaraProvenanceRow[]> {
  const { data, error } = await client.rpc('samskara_provenance_detail', {
    p_samskara_id: samskaraId,
  });
  if (error) throw new SupabaseError(error.message);
  return ((data ?? []) as {
    kind: string;
    ref_id: string;
    weight: number;
    label: string | null;
    ref_tier: number | null;
  }[]).map((r) => ({
    kind: r.kind as SamskaraProvenanceRow['kind'],
    refId: r.ref_id,
    weight: r.weight,
    label: r.label,
    refTier: r.ref_tier,
  }));
}

/**
 * One-row corpus-wide health snapshot for the Health panel: backlog
 * depths, lost-signal counts, inconsistency counts, corpus-quality
 * counts. Computed live; no stored history.
 */
export async function samskaraHealthSnapshot(
  client: SupabaseClient
): Promise<SamskaraHealthSnapshot> {
  const { data, error } = await client.rpc('samskara_health_snapshot');
  if (error) throw new SupabaseError(error.message);
  // The RPC returns a single-row table; supabase-js hands it back as a
  // one-element array.
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, number> | null;
  return {
    totalSamskaras: r?.total_samskaras ?? 0,
    tier1: r?.tier1 ?? 0,
    tier2: r?.tier2 ?? 0,
    nearDead: r?.near_dead ?? 0,
    neverFired: r?.never_fired ?? 0,
    probationEligible: r?.probation_eligible ?? 0,
    evictable: r?.evictable ?? 0,
    evictableStale: r?.evictable_stale ?? 0,
    evictableUnhealthy: r?.evictable_unhealthy ?? 0,
    associations: r?.associations ?? 0,
    associationsUnconsumed: r?.associations_unconsumed ?? 0,
    substrateTotal: r?.substrate_total ?? 0,
    pendingAssimilate: r?.pending_assimilate ?? 0,
    pendingEmbed: r?.pending_embed ?? 0,
    firesTotal: r?.fires_total ?? 0,
    firesAwaitingJudgment: r?.fires_awaiting_judgment ?? 0,
    orphanFires: r?.orphan_fires ?? 0,
    stuckAssimilateClaims: r?.stuck_assimilate_claims ?? 0,
    stuckEmbedClaims: r?.stuck_embed_claims ?? 0,
  };
}

/**
 * Windowed activity rates (mints/fires/resolution over the last N
 * days) for the Health panel, computed from existing timestamps.
 */
export async function samskaraRates(
  client: SupabaseClient,
  days: number
): Promise<SamskaraRates> {
  const { data, error } = await client.rpc('samskara_rates', { p_days: days });
  if (error) throw new SupabaseError(error.message);
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, number> | null;
  return {
    windowDays: r?.window_days ?? days,
    mints: r?.mints ?? 0,
    fires: r?.fires ?? 0,
    resolved: r?.resolved ?? 0,
    unresolved: r?.unresolved ?? 0,
    resolutionPct: r?.resolution_pct ?? 0,
    held: r?.held ?? 0,
    contradicted: r?.contradicted ?? 0,
    notBorneOut: r?.not_borne_out ?? 0,
    notEngaged: r?.not_engaged ?? 0,
  };
}

/**
 * Lifetime verdict tally for one samskara's fires, for the detail
 * pane. Raw counts (not the EWMA-discounted confirm/disconfirm the row
 * carries) so the soft-miss bucket reads next to the others. pending =
 * fired but not yet judged.
 */
export async function samskaraVerdictCounts(
  client: SupabaseClient,
  samskaraId: string
): Promise<SamskaraVerdictCounts> {
  const { data, error } = await client.rpc('samskara_verdict_counts', {
    p_samskara_id: samskaraId,
  });
  if (error) throw new SupabaseError(error.message);
  // Mixed row shape: the counts are numbers, last_genuine_at is a
  // timestamp string (or null when never genuinely tested).
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return {
    held: (r?.held as number) ?? 0,
    contradicted: (r?.contradicted as number) ?? 0,
    notBorneOut: (r?.not_borne_out as number) ?? 0,
    notEngaged: (r?.not_engaged as number) ?? 0,
    pending: (r?.pending as number) ?? 0,
    lastGenuineAt: (r?.last_genuine_at as string | null) ?? null,
  };
}

/**
 * Health panel readout: how many tier-1 members the tier-2 detector
 * would currently offer the minter (0 = nothing available). Calls the
 * same detection RPC the sweep's mint-tier2 phase uses - a non-empty
 * return with few tier-2s is the signal detection is finding uncovered
 * constellations again (the instrument that would have surfaced the
 * "empty every sweep" stall the lift redesign fixed). The RPC is
 * security-invoker and scopes to auth.uid() with no args.
 */
export async function samskaraTier2CandidateSize(client: SupabaseClient): Promise<number> {
  const { data, error } = await client.rpc('samskara_tier2_candidate');
  if (error) throw new SupabaseError(error.message);
  return Array.isArray(data) ? data.length : 0;
}
