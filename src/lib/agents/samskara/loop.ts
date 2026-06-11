/**
 * Single-cycle driver for the samskara formation worker. The outer
 * loop in `./worker.ts` calls `runOneCycle` repeatedly until abort.
 * Shape mirrors `src/lib/agents/reflection/loop.ts` deliberately — same
 * lease acquire -> claim -> work -> save progression.
 *
 * One cycle = one observable state transition. Unlike a single-claim
 * worker (one row claimed and saved per cycle), the samskara worker has
 * multiple PHASES per cycle: the outer worker calls runOneCycle once and
 * the cycle internally advances exactly one phase (assimilate /
 * pair-relate /
 * cluster-mint-tier1 / cluster-mint-tier2 / reaction-classify /
 * dedup / compound-regen). Phase rotation is round-robin across
 * cycles via the caller's `phaseIndex` state.
 *
 * Why phase rotation in the cycle (vs the worker): the cycle is the
 * unit of test isolation. A test that wants to verify "the assimilate
 * phase claims a row, calls the assimilator, saves, returns
 * 'progress'" can drive that one phase deterministically by passing
 * `phase: 'assimilate'`.
 */
import type { SupabaseService, SamskaraSubstrateRow } from '../../supabase';
import { VeniceError } from '../../venice';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '../../models';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { SamskaraAgent } from './agent';
import { createLogger } from '../../logger.svelte';

// Per-phase decision breadcrumbs. Two tiers in use here:
//   - `trace` for routine "phase had nothing to do" lines that fire
//     every rotation when the worker is idle. They'd drown the drawer
//     at the default tier and carry no diagnostic value when there's
//     no work, so they're behind the Trace+ filter.
//   - `debug` for breadcrumbs that fire only when a phase actually
//     claimed a row, called the agent, or wrote something. These
//     remain visible at the default Debug+ tier so a developer
//     watching the drawer sees the shape of real work without lifting
//     the filter.
// Shared source tag with the manager so the Logs drawer groups worker
// output regardless of which file emitted it.
const log = createLogger('samskara-worker');

/**
 * Cosine-similarity threshold above which a proposed mint-tier1 claim
 * is treated as a near-duplicate of an existing samskara. Tuned on
 * observed corpus behaviour (April 2026): genuine paraphrases of the
 * same underlying claim clustered well above 0.9 on Venice's large
 * embedder, so 0.85 leaves a margin while still collapsing the class
 * of "heirloom wheat alchemist" vs "heritage grains dough whisperer"
 * near-clones that a real conversation surfaces within minutes.
 *
 * The threshold is intentionally MINT-only. The fire path has no
 * similarity filter; weak-but-related samskaras still need to reach
 * the priming block so cohort reinforcement can happen.
 */
const MINT_DEDUP_COSINE = 0.85;

/**
 * Health nudge applied to a reinforced samskara on a dedup hit. Small
 * by design - re-observing a similar claim is a weak positive signal
 * (the user didn't actively confirm it), so the main confidence swing
 * still comes from reaction-classify's confirm/disconfirm path. The
 * RPC caps the resulting health at 1.0.
 */
const MINT_DEDUP_HEALTH_BUMP = 0.02;

/**
 * Topical-cluster tuning for mint-tier1. The phase used to hand the
 * minter the 8 most-recent substrate rows verbatim ("treat the most
 * recent N as one cluster"), so a session that hopped topics produced
 * predictions fused across unrelated turns ("in situations involving
 * physics OR culinary history...") and provenance littered with
 * temporally-adjacent bystander rows. Instead, seed on the most-recent
 * row and keep only rows whose situation embedding is close to it, so
 * both the minter input and the recorded provenance are one coherent
 * topic.
 *
 * MINT_CLUSTER_COSINE_FLOOR is empirical: across this corpus, RANDOM
 * substrate pairs already average ~0.50 cosine (the embedding space is
 * compressed - everything is one user's chat turns), while same-topic
 * runs measured ~0.6-0.75. 0.6 sits at the random p90, so it admits
 * most same-topic neighbours while rejecting ~90% of cross-topic ones.
 * The separation is imperfect by nature of the compressed space; this
 * is a deliberate floor, not a hard boundary.
 *
 * MINT_CLUSTER_MAX caps the minter's sample (and the provenance batch)
 * at 5, matching the old slice. MINT_CLUSTER_MIN requires at least 3
 * coherent rows before minting - a one-off exchange with no topical
 * neighbours in the recent window shouldn't crystallize into an
 * instinct yet.
 */
const MINT_CLUSTER_COSINE_FLOOR = 0.6;
const MINT_CLUSTER_MAX = 5;
const MINT_CLUSTER_MIN = 3;

/** All worker phases. Iteration order is significant - see PHASES below. */
export type SamskaraPhase =
  | 'assimilate'
  | 'pair-relate'
  | 'mint-tier1'
  | 'mint-tier2'
  | 'reaction-classify'
  | 'dedup'
  | 'compound-regen';

/**
 * Phase rotation order. Assimilate runs first because every other
 * phase depends on enriched substrate; pair-relate next because
 * mint depends on association rows; mint-tier1 before mint-tier2
 * because tier 2 depends on tier-1 cohort patterns; reaction-classify
 * is independent and can run any time; compound-regen runs last so
 * its summary input reflects the freshest tier-2 state AND the
 * post-dedup tier-1 pool.
 *
 * Decay is NOT a worker phase: it runs server-side as the
 * nak-samskara-decay pg_cron job (samskara_decay_sweep in
 * schema.sql), so dedup sees health values at most half an hour
 * stale - fine, since a collapsed loser folds its counters into the
 * winner regardless of either row's current health.
 */
export const PHASES: readonly SamskaraPhase[] = [
  'assimilate',
  'pair-relate',
  'mint-tier1',
  'mint-tier2',
  'reaction-classify',
  'dedup',
  'compound-regen',
];

export type CycleResult =
  /** Just took the lease. Caller should recurse immediately. */
  | 'acquired-lease'
  /** Someone else holds the lease. Polling. */
  | 'polling'
  /** Lease held but the chosen phase had nothing to do. Drain to next phase. */
  | 'empty-phase'
  /** Phase ran an LLM call and made forward progress. */
  | 'progress'
  /** Phase ran but the underlying claim/save was rejected. Drain. */
  | 'save-rejected'
  /** Venice rate-limited. Long back-off. */
  | 'rate-limited'
  /** Transient Venice/Supabase error. Short back-off. */
  | 'error';

export interface CycleContext {
  agent: SamskaraAgent;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  /** Per-row claim TTL, seconds. Generous - LLM call timing varies. */
  claimTtlSeconds: number;
  /** Compound-regen claim TTL, seconds. Even more generous - one call per regen. */
  regenClaimTtlSeconds: number;
  /** Phase to advance this cycle. The caller round-robins via PHASES. */
  phase: SamskaraPhase;
  signal: AbortSignal;
  onLeaseLost: () => void;
  /**
   * Called after a new samskara commits, so the main thread can surface
   * a subtle toast. Fired only after the DB insert and provenance
   * upsert both succeed, not on empty-phase or error paths. Optional so
   * unit tests and non-UI contexts can omit it.
   */
  onMint?: (info: { tier: 1 | 2; valence: number; confidence: number }) => void;
  /**
   * Cross-rotation throttle for the exploratory phases (mint-tier1,
   * pair-relate). Both phases probe "is there a new pair I should
   * relate?" / "is there a cluster I should mint?" on every entry
   * by fetching the recent substrate and calling an LLM agent
   * against it. Without a throttle they fire every ~9 seconds
   * forever because the dedup-reinforce branch in mint-tier1
   * always returns 'progress' when there's any existing substrate
   * to match against, pinning the outer worker's `allEmpty` gate
   * to false and skipping the idle nap indefinitely.
   *
   * Owned by the worker so state survives rotations. `lastRunMs`
   * is the timestamp of the most recent successful run; reset to
   * 0 on lease loss so a recovered device re-explores once. The
   * map is the per-phase scoping; defaulting to a single shared
   * `minIntervalMs` keeps tuning simple.
   *
   * Throttle skips happen BEFORE the substrate fetch, which is
   * the expensive bit - mint-tier1's limit-8 query returns ~8 *
   * 2048-dim embeddings (~130 KB), pair-relate's limit-40 query
   * returns ~640 KB. Suppressing those payloads is the main
   * point.
   */
  phaseThrottle: {
    lastRunMs: Map<SamskaraPhase, number>;
    minIntervalMs: number;
    /**
     * Per-phase interval overrides. mint-tier2 sets a longer interval
     * than the shared default: compound patterns form over many turns,
     * and its detection self-join is heavier than the substrate fetches
     * the tier-1/pair-relate phases throttle. A phase absent from this
     * map falls back to `minIntervalMs`.
     */
    intervalOverridesMs?: Partial<Record<SamskaraPhase, number>>;
  };
}

export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'empty-phase';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) return 'polling';
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    return 'acquired-lease';
  }

  // Rate-limit propagation. Each phase function may throw a
  // VeniceError with kind='rate_limit' (the agent re-throws those
  // so the loop can distinguish from generic parse failures). Catch
  // them here once rather than per-phase, and map to 'rate-limited'
  // so napForResult picks the long back-off.
  try {
    switch (ctx.phase) {
      case 'assimilate':
        return await runAssimilatePhase(ctx);
      case 'pair-relate':
        return await runPairRelatePhase(ctx);
      case 'mint-tier1':
        return await runMintTier1Phase(ctx);
      case 'mint-tier2':
        return await runMintTier2Phase(ctx);
      case 'reaction-classify':
        return await runReactionClassifyPhase(ctx);
      case 'dedup':
        return await runDedupPhase(ctx);
      case 'compound-regen':
        return await runCompoundRegenPhase(ctx);
    }
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') {
      return 'rate-limited';
    }
    return 'error';
  }
}

/**
 * Cross-rotation throttle gate for exploratory phases. Returns
 * true (caller should return 'empty-phase') when the phase ran
 * inside the throttle window. The stamp happens AFTER the
 * expensive substrate fetch so a throttled call costs zero
 * RPCs and zero LLM time.
 */
function isPhaseThrottled(ctx: CycleContext, phase: SamskaraPhase): boolean {
  const last = ctx.phaseThrottle.lastRunMs.get(phase);
  if (!last) return false;
  const interval =
    ctx.phaseThrottle.intervalOverridesMs?.[phase] ?? ctx.phaseThrottle.minIntervalMs;
  const sinceLast = Date.now() - last;
  if (sinceLast >= interval) return false;
  log.trace(
    `${phase}: throttled ` +
      `(last run ${Math.round(sinceLast / 1000)}s ago, ` +
      `min interval ${Math.round(interval / 1000)}s)`
  );
  return true;
}

// --- Phase implementations ----------------------------------------------

/**
 * Assimilate one substrate stub. Claims a row where situation IS
 * NULL, fetches the user + assistant messages it points at, calls
 * the assimilator agent, saves the structured fields under the
 * claim guard.
 */
async function runAssimilatePhase(ctx: CycleContext): Promise<CycleResult> {
  let claim;
  try {
    claim = await ctx.supabase.samskaraClaimNextAssimilate(
      ctx.holderId,
      ctx.claimTtlSeconds
    );
  } catch (err) {
    log.debug('assimilate: claim RPC failed', err);
    return 'error';
  }
  if (!claim) return 'empty-phase';
  // Lifecycle headline parallel to "picked up thread X" in the
  // other agent workers - logged at .info so the user can see
  // samskara firing in the drawer at the default level.
  log.info(
    `assimilate: claimed substrate ${claim.id} ` +
      `(thread ${claim.threadId})`
  );

  // Fetch the two messages this substrate row anchors. assistantMessageId
  // can be null (a turn that errored before the assistant row landed); in
  // that case we feed the agent an empty assistant message.
  let userMsg = '';
  let assistantMsg = '';
  try {
    const messages = await ctx.supabase.listMessages(claim.threadId);
    const u = messages.find((m) => m.id === claim.userMessageId);
    if (u) userMsg = u.content;
    if (claim.assistantMessageId) {
      const a = messages.find((m) => m.id === claim.assistantMessageId);
      if (a) assistantMsg = a.content;
    }
  } catch {
    return 'error';
  }
  if (userMsg.length === 0) {
    // The user message disappeared (thread deleted, message edit). We
    // can't assimilate without it. Save a placeholder so the row stops
    // showing up in the assimilate queue; the worker drains.
    try {
      const ok = await ctx.supabase.samskaraSaveAssimilation(
        claim.id,
        ctx.holderId,
        '(source message unavailable)',
        '',
        0
      );
      return ok ? 'progress' : 'save-rejected';
    } catch {
      return 'error';
    }
  }

  const result = await ctx.agent.assimilate(userMsg, assistantMsg, ctx.signal);
  if (!result) {
    log.debug('assimilate: agent returned null', { substrateId: claim.id });
    return 'error';
  }
  log.debug('assimilate: agent returned', {
    substrateId: claim.id,
    situation: shorten(result.situation),
    valence: result.valence,
  });

  let saved: boolean;
  try {
    saved = await ctx.supabase.samskaraSaveAssimilation(
      claim.id,
      ctx.holderId,
      result.situation,
      result.outcome,
      result.valence
    );
  } catch (err) {
    log.debug('assimilate: save failed', err);
    return 'error';
  }
  if (!saved) {
    log.debug('assimilate: save rejected (claim expired?)', { substrateId: claim.id });
  } else {
    // Lifecycle "finished" line parallel to "finished thread X" in
    // the other agent workers. Logged at .info; details about the
    // assimilation result stay on the .debug line above.
    log.info(`assimilate: saved substrate ${claim.id}`);
  }
  return saved ? 'progress' : 'save-rejected';
}

/**
 * Pair-relate phase. Reads recent embedded substrate, computes
 * cosine for the most recent row against its predecessors, picks the
 * best non-self pair, calls the relator agent, upserts the
 * association row when the verdict is non-orthogonal.
 *
 * One pair per cycle keeps the LLM call rate bounded; the caller
 * loops cycles to drain the queue. Naive O(n) per cycle is fine at
 * substrate-corpus scale (low thousands per user max).
 */
async function runPairRelatePhase(ctx: CycleContext): Promise<CycleResult> {
  if (isPhaseThrottled(ctx, 'pair-relate')) return 'empty-phase';
  let recent: SamskaraSubstrateRow[];
  try {
    recent = await ctx.supabase.samskaraRecentEmbeddedSubstrate(40);
  } catch {
    return 'error';
  }
  // Stamp the throttle clock once the expensive part is done.
  // Subsequent rotations within minIntervalMs skip this phase
  // entirely. Errors during the substrate fetch don't stamp -
  // they get the usual error back-off and retry naturally.
  ctx.phaseThrottle.lastRunMs.set('pair-relate', Date.now());
  if (recent.length < 2) return 'empty-phase';

  // Walk the most recent row; find its closest neighbour in the rest
  // by cosine similarity. Skips pairs whose association already
  // exists (the upsert would just bump reinforcement, but we also
  // don't want to waste an LLM call labelling something already
  // labelled). For v1 we don't track "already-related" exhaustively;
  // the unique constraint on (a_id, b_id, label) catches duplicates
  // at write-time.
  const seed = recent[0];
  if (!seed.situation_embedding) return 'empty-phase';
  let bestIdx = -1;
  let bestSim = -Infinity;
  for (let i = 1; i < recent.length; i++) {
    const candidate = recent[i];
    if (!candidate.situation_embedding) continue;
    const sim = cosine(
      seed.situation_embedding as number[],
      candidate.situation_embedding as number[]
    );
    if (sim > bestSim) {
      bestSim = sim;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestSim < 0.3) {
    log.trace('pair-relate: no viable pair', {
      candidates: recent.length,
      bestSim: bestSim === -Infinity ? null : bestSim,
    });
    return 'empty-phase';
  }

  const partner = recent[bestIdx];
  // Lifecycle "picked up" line parallel to the other agents' "picked
  // up X" - .info so it's visible at the default log level.
  log.info(
    `pair-relate: selected pair ${seed.id} <> ${partner.id} ` +
      `(cosine ${bestSim.toFixed(3)})`
  );
  const result = await ctx.agent.relate(
    { situation: seed.situation, outcome: seed.outcome },
    { situation: partner.situation, outcome: partner.outcome },
    ctx.signal
  );
  if (!result) {
    log.debug('pair-relate: agent returned null');
    return 'error';
  }
  if (result.kind === 'orthogonal' || result.label.length === 0) {
    // Agent declined. Not an error; drain.
    log.debug('pair-relate: agent declined', { kind: result.kind });
    return 'empty-phase';
  }

  // Direct insert with on-conflict-do-update so re-encountering the
  // same pair+label bumps reinforcement instead of failing.
  const aId = seed.id < partner.id ? seed.id : partner.id;
  const bId = seed.id < partner.id ? partner.id : seed.id;
  try {
    const { error } = await (ctx.supabase as unknown as {
      client: {
        from: (t: string) => {
          upsert: (
            row: Record<string, unknown>,
            opts: Record<string, unknown>
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
    }).client
      .from('samskara_associations')
      .upsert(
        {
          a_id: aId,
          b_id: bId,
          articulated_relation: result.label,
          kind: result.kind,
          reinforcement: 1,
          last_reinforced_at: new Date().toISOString(),
        },
        {
          onConflict: 'user_id,a_id,b_id,articulated_relation',
          ignoreDuplicates: false,
        }
      );
    if (error) {
      log.debug('pair-relate: upsert error', error);
      return 'error';
    }
  } catch (err) {
    log.debug('pair-relate: upsert threw', err);
    return 'error';
  }
  // Lifecycle "finished" line - .info so the user sees the
  // association land in the drawer at the default log level.
  log.info(
    `pair-relate: associated ${aId} <> ${bId} (${result.kind}: ${shorten(result.label)})`
  );
  return 'progress';
}

/**
 * Mint a tier-1 samskara from a substrate cluster. Stub implementation
 * for v1 — the full clustering pass uses associations to seed
 * clusters, but the simpler "treat the most recent N substrate rows
 * as one cluster, mint a samskara if the agent agrees" version is
 * sufficient until we observe the long tail behaviour. Returns
 * empty-phase when there's not enough substrate yet.
 */
async function runMintTier1Phase(ctx: CycleContext): Promise<CycleResult> {
  if (isPhaseThrottled(ctx, 'mint-tier1')) return 'empty-phase';
  let recent: SamskaraSubstrateRow[];
  try {
    recent = await ctx.supabase.samskaraRecentEmbeddedSubstrate(8);
  } catch (err) {
    log.debug('mint-tier1: substrate fetch failed', err);
    return 'error';
  }
  // Stamp the throttle clock once the expensive part is done.
  // Subsequent rotations within minIntervalMs skip this phase
  // entirely - that's the whole point of the gate, since the
  // substrate query carries 8 * 2048-dim embeddings (~130 KB)
  // and the followup mint agent call burns Venice budget.
  ctx.phaseThrottle.lastRunMs.set('mint-tier1', Date.now());
  if (recent.length < MINT_CLUSTER_MIN) {
    log.trace('mint-tier1: insufficient substrate', {
      have: recent.length,
      need: MINT_CLUSTER_MIN,
    });
    return 'empty-phase';
  }

  // Build a topical cluster instead of taking the recent rows verbatim:
  // seed on the most-recent row and keep only same-topic neighbours
  // (situation-embedding cosine >= floor). This is what keeps the
  // minter from fusing unrelated turns into one prediction and keeps
  // provenance pointing at the rows that actually share the claim's
  // topic. See MINT_CLUSTER_* for the floor's empirical basis.
  const clusterRows = buildTopicalCluster(recent);
  if (clusterRows.length < MINT_CLUSTER_MIN) {
    log.trace('mint-tier1: no coherent cluster', {
      fetched: recent.length,
      coherent: clusterRows.length,
      need: MINT_CLUSTER_MIN,
    });
    return 'empty-phase';
  }

  const cluster = {
    sample_labels: [],
    sample_situations: clusterRows.map((r) => r.situation),
    reinforcement: clusterRows.length,
  };
  log.trace('mint-tier1: asking agent', {
    fetched: recent.length,
    clustered: clusterRows.length,
  });
  const minted = await ctx.agent.mint(cluster, ctx.signal);
  if (!minted) {
    log.trace('mint-tier1: agent declined');
    return 'empty-phase';
  }

  // Embed the prediction so future fire queries can match against it.
  let predEmbedding: number[];
  try {
    const resp = await ctx.supabase.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: minted.prediction,
      signal: ctx.signal,
    });
    const raw = resp.data[0]?.embedding;
    if (!raw || raw.length === 0) return 'error';
    predEmbedding = padEmbeddingForStorage(raw);
  } catch {
    return 'error';
  }

  // Dedup guard. The minter agent only sees the substrate cluster and
  // has no visibility into the existing samskara corpus, so it
  // cheerfully produces reworded versions of claims that are already
  // present. Query the nearest existing samskara by cosine on
  // `prediction_embedding`; when the similarity exceeds the threshold,
  // reinforce that row (health bump only) instead of minting a twin. A
  // failure of the dedup check itself is non-fatal - we'd rather mint a
  // possible twin than drop a valid signal, and the one-shot collapse
  // RPC is available as a cleanup lane.
  try {
    const nearest = await ctx.supabase.samskaraNearestByPrediction(predEmbedding, 1);
    if (nearest.length > 0 && nearest[0].cosine >= MINT_DEDUP_COSINE) {
      await ctx.supabase.samskaraReinforceExisting(nearest[0].id, MINT_DEDUP_HEALTH_BUMP);
      log.debug('mint-tier1: dedup-reinforced existing', {
        id: nearest[0].id,
        cosine: nearest[0].cosine,
        candidate: shorten(minted.prediction),
      });
      return 'progress';
    }
  } catch (err) {
    log.debug('mint-tier1: dedup check failed, proceeding with mint', err);
  }

  // Insert via raw client so we can write provenance in the same
  // round trip. The dedup guard above catches the common case of
  // near-duplicates; the raw insert still has no uniqueness
  // constraint on prediction text, so a genuine novel claim whose
  // embedding happens to sit just below MINT_DEDUP_COSINE will land
  // here as a new row. That's the intended behaviour.
  let samskaraId = '';
  try {
    const client = (ctx.supabase as unknown as {
      client: {
        from: (t: string) => {
          insert: (row: Record<string, unknown>) => {
            select: (cols: string) => {
              single: () => Promise<{
                data: { id: string } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    }).client;
    const { data, error } = await client
      .from('samskaras')
      .insert({
        tier: 1,
        prediction: minted.prediction,
        prediction_embedding: predEmbedding,
        inner_voice: minted.innerVoice.length > 0 ? minted.innerVoice : null,
        valence: minted.valence,
        confidence: minted.confidence,
      })
      .select('id')
      .single();
    if (error || !data) {
      log.debug('mint-tier1: samskaras insert failed', error);
      return 'error';
    }
    samskaraId = data.id;
    // Provenance: link this samskara back to the topical cluster rows
    // that fed it - the same coherent set the minter saw, not the raw
    // recency window. ignoreDuplicates handles re-runs cleanly.
    const provRows = clusterRows.map((r) => ({
      samskara_id: data.id,
      kind: 'substrate' as const,
      ref_id: r.id,
      weight: 1.0,
    }));
    const provClient = (ctx.supabase as unknown as {
      client: {
        from: (t: string) => {
          upsert: (
            rows: Record<string, unknown>[],
            opts: Record<string, unknown>
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
    }).client;
    await provClient.from('samskara_provenance').upsert(provRows, {
      onConflict: 'samskara_id,kind,ref_id',
      ignoreDuplicates: true,
    });
  } catch (err) {
    log.debug('mint-tier1: insert threw', err);
    return 'error';
  }
  log.info('mint-tier1: minted samskara', {
    id: samskaraId,
    prediction: shorten(minted.prediction),
    valence: minted.valence,
    confidence: minted.confidence,
  });
  // Notify the main thread. Swallowed-by-ctx when the caller didn't
  // wire the callback (tests); otherwise bubbles a subtle toast.
  ctx.onMint?.({
    tier: 1,
    valence: minted.valence,
    confidence: minted.confidence,
  });
  return 'progress';
}

/**
 * Mint a tier-2 (compound) samskara from a recurring co-fire
 * constellation of tier-1 samskaras. Mirrors runMintTier1Phase: detect
 * the candidate (here a co-fire group rather than a substrate cluster),
 * ask the agent, embed, dedup-guard, insert + provenance, fire onMint.
 *
 * Two dedup guards, not one. The detection RPC already skips groups an
 * existing tier-2 covers by child-set overlap (same children); the
 * embedding guard below catches the orthogonal case - a DIFFERENT child
 * set that the agent synthesized into the same claim text.
 */
async function runMintTier2Phase(ctx: CycleContext): Promise<CycleResult> {
  if (isPhaseThrottled(ctx, 'mint-tier2')) return 'empty-phase';
  let candidate;
  try {
    candidate = await ctx.supabase.samskaraTier2Candidate();
  } catch (err) {
    log.debug('mint-tier2: candidate RPC failed', err);
    return 'error';
  }
  // Stamp the throttle clock after the expensive detection self-join,
  // same as the tier-1/pair-relate phases. An empty result still
  // stamps - we don't want to re-run the self-join every rotation when
  // there's no eligible group.
  ctx.phaseThrottle.lastRunMs.set('mint-tier2', Date.now());
  if (candidate.length < 3) {
    log.trace('mint-tier2: no candidate group', { size: candidate.length });
    return 'empty-phase';
  }
  log.info(`mint-tier2: candidate group of ${candidate.length} tier-1 samskaras`);

  const minted = await ctx.agent.mintTier2(
    candidate.map((c) => ({ prediction: c.prediction, valence: c.valence })),
    ctx.signal
  );
  if (!minted) {
    log.trace('mint-tier2: agent declined');
    return 'empty-phase';
  }

  // Embed the compound prediction so it fires by cosine like any
  // samskara. Same pad-to-storage-width path as tier-1.
  let predEmbedding: number[];
  try {
    const resp = await ctx.supabase.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: minted.prediction,
      signal: ctx.signal,
    });
    const raw = resp.data[0]?.embedding;
    if (!raw || raw.length === 0) return 'error';
    predEmbedding = padEmbeddingForStorage(raw);
  } catch {
    return 'error';
  }

  // Embedding dedup against existing tier-2s only (p_tier=2). A hit
  // means the agent re-derived an existing compound from a different
  // child set; bump its health rather than minting a twin. Reinforce
  // touches health only - it never writes provenance - so the
  // compound's tier-1 child links stay as they were minted.
  try {
    const nearest = await ctx.supabase.samskaraNearestByPrediction(predEmbedding, 1, 2);
    if (nearest.length > 0 && nearest[0].cosine >= MINT_DEDUP_COSINE) {
      await ctx.supabase.samskaraReinforceExisting(nearest[0].id, MINT_DEDUP_HEALTH_BUMP);
      log.debug('mint-tier2: dedup-reinforced existing compound', {
        id: nearest[0].id,
        cosine: nearest[0].cosine,
        candidate: shorten(minted.prediction),
      });
      return 'progress';
    }
  } catch (err) {
    log.debug('mint-tier2: dedup check failed, proceeding with mint', err);
  }

  // Insert the tier-2 row, then provenance pointing at the tier-1
  // children with kind='samskara'. Raw client to write both in the same
  // round trip, matching the tier-1 mint path in this file.
  let samskaraId = '';
  try {
    const client = (ctx.supabase as unknown as {
      client: {
        from: (t: string) => {
          insert: (row: Record<string, unknown>) => {
            select: (cols: string) => {
              single: () => Promise<{
                data: { id: string } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    }).client;
    const { data, error } = await client
      .from('samskaras')
      .insert({
        tier: 2,
        prediction: minted.prediction,
        prediction_embedding: predEmbedding,
        inner_voice: minted.innerVoice.length > 0 ? minted.innerVoice : null,
        valence: minted.valence,
        confidence: minted.confidence,
      })
      .select('id')
      .single();
    if (error || !data) {
      log.debug('mint-tier2: samskaras insert failed', error);
      return 'error';
    }
    samskaraId = data.id;
    const provRows = candidate.map((c) => ({
      samskara_id: data.id,
      kind: 'samskara' as const,
      ref_id: c.samskaraId,
      weight: c.cofireWeight,
    }));
    const provClient = (ctx.supabase as unknown as {
      client: {
        from: (t: string) => {
          upsert: (
            rows: Record<string, unknown>[],
            opts: Record<string, unknown>
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
    }).client;
    await provClient.from('samskara_provenance').upsert(provRows, {
      onConflict: 'samskara_id,kind,ref_id',
      ignoreDuplicates: true,
    });
  } catch (err) {
    log.debug('mint-tier2: insert threw', err);
    return 'error';
  }
  log.info('mint-tier2: minted compound samskara', {
    id: samskaraId,
    children: candidate.length,
    prediction: shorten(minted.prediction),
    valence: minted.valence,
    confidence: minted.confidence,
  });
  ctx.onMint?.({
    tier: 2,
    valence: minted.valence,
    confidence: minted.confidence,
  });
  return 'progress';
}

/**
 * Reaction-classify the most recent unresolved cohort fire. Reads the
 * cohort, the assistant message that was sent, and the user message
 * that came next; calls the classifier agent; applies the reaction.
 */
async function runReactionClassifyPhase(ctx: CycleContext): Promise<CycleResult> {
  // Find the most recent unresolved cohort whose follow-up user
  // message has landed. We look for fires where:
  //   - was_confirmed is null (unresolved)
  //   - fired_at is between 1 and 10 minutes ago - the design's
  //     resolution window (see docs/dev/samskara.md). Older fires
  //     age out via decay rather than being force-classified by
  //     stale next-turn signal; the 1-minute floor avoids racing a
  //     turn that's still in flight.
  // Group by cohort_id, take the oldest within the window so we
  // don't skip ones the user is actively responding to.
  const client = (ctx.supabase as unknown as {
    client: {
      from: (t: string) => {
        select: (cols: string) => {
          is: (col: string, val: null) => {
            gte: (col: string, val: string) => {
              lte: (col: string, val: string) => {
                order: (col: string, opts: { ascending: boolean }) => {
                  limit: (n: number) => Promise<{
                    data:
                      | {
                          cohort_id: string;
                          thread_id: string;
                          samskara_id: string;
                          fired_at: string;
                        }[]
                      | null;
                    error: { message: string } | null;
                  }>;
                };
              };
            };
          };
        };
      };
    };
  }).client;
  const now = new Date();
  const minAge = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const maxAge = new Date(now.getTime() - 60 * 1000).toISOString();
  let candidate;
  try {
    const { data, error } = await client
      .from('samskara_fires')
      .select('cohort_id, thread_id, samskara_id, fired_at')
      .is('was_confirmed', null)
      .gte('fired_at', minAge)
      .lte('fired_at', maxAge)
      .order('fired_at', { ascending: true })
      .limit(1);
    if (error || !data || data.length === 0) return 'empty-phase';
    candidate = data[0];
  } catch (err) {
    log.debug('reaction-classify: candidate query failed', err);
    return 'error';
  }
  log.debug('reaction-classify: candidate cohort', {
    cohortId: candidate.cohort_id,
    threadId: candidate.thread_id,
    firedAt: candidate.fired_at,
  });

  // Fetch the full cohort + the surrounding messages.
  const cohortClient = (ctx.supabase as unknown as {
    client: {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => Promise<{
            data: { samskara_id: string }[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  }).client;
  let cohortIds: string[];
  try {
    const { data, error } = await cohortClient
      .from('samskara_fires')
      .select('samskara_id')
      .eq('cohort_id', candidate.cohort_id);
    if (error || !data) return 'error';
    cohortIds = data.map((r) => r.samskara_id);
  } catch {
    return 'error';
  }
  if (cohortIds.length === 0) return 'empty-phase';

  // Pull the prediction text for each cohort member.
  const samskaraClient = (ctx.supabase as unknown as {
    client: {
      from: (t: string) => {
        select: (cols: string) => {
          in: (col: string, vals: string[]) => Promise<{
            data: { id: string; prediction: string }[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  }).client;
  let cohort;
  try {
    const { data, error } = await samskaraClient
      .from('samskaras')
      .select('id, prediction')
      .in('id', cohortIds);
    if (error || !data) return 'error';
    cohort = data.map((r) => ({ id: r.id, prediction: r.prediction }));
  } catch {
    return 'error';
  }

  // Find the assistant + next user messages in the thread.
  let assistantMsg = '';
  let nextUserMsg = '';
  try {
    const messages = await ctx.supabase.listMessages(candidate.thread_id);
    const firedAt = new Date(candidate.fired_at).getTime();
    // Assistant message after firedAt with no tool_calls and a non-empty content.
    const assistant = messages.find((m) => {
      if (m.role !== 'assistant') return false;
      if (m.tool_calls && m.tool_calls.length > 0) return false;
      if (!m.content || m.content.length === 0) return false;
      return new Date(m.created_at).getTime() >= firedAt;
    });
    // User message after that assistant.
    if (assistant) {
      assistantMsg = assistant.content;
      const nextUser = messages.find((m) => {
        if (m.role !== 'user') return false;
        return new Date(m.created_at).getTime() > new Date(assistant.created_at).getTime();
      });
      if (nextUser) nextUserMsg = nextUser.content;
    }
  } catch {
    return 'error';
  }
  if (assistantMsg.length === 0 || nextUserMsg.length === 0) {
    // The user hasn't replied yet (or the thread shape doesn't fit).
    // Leave the cohort unresolved; decay handles it after the
    // 10-minute window.
    return 'empty-phase';
  }

  const result = await ctx.agent.classifyReaction(
    cohort,
    assistantMsg,
    nextUserMsg,
    ctx.signal
  );
  if (!result) {
    log.debug('reaction-classify: agent returned null');
    return 'error';
  }

  try {
    await ctx.supabase.samskaraApplyReaction(
      candidate.cohort_id,
      result.confirm,
      result.disconfirm,
      result.neutral
    );
  } catch (err) {
    log.debug('reaction-classify: apply RPC failed', err);
    return 'error';
  }
  log.info('reaction-classify: applied', {
    cohortId: candidate.cohort_id,
    cohortSize: cohort.length,
    confirm: result.confirm.length,
    disconfirm: result.disconfirm.length,
    neutral: result.neutral.length,
  });
  return 'progress';
}

/**
 * Dedup phase. Calls `samskara_collapse_by_cofiring` which uses
 * co-firing evidence as its primary redundancy signal with an
 * embedding-cosine sanity floor, plus a population-count safety cap
 * that activates above the target tier-1 count. SQL-only, no LLM.
 *
 * Runs each rotation: the RPC caps itself at 20 collapses per call
 * via `p_max_collapses`, so a genuinely over-populated pool drains
 * across many cycles rather than one giant transaction. Returns
 * 'empty-phase' when no collapses happened - that keeps the cycle
 * driver's napping behaviour accurate (a string of empty phases
 * means nothing to do, so sleep longer).
 *
 * Parameters are the wrapper's defaults on purpose: the worker is
 * the primary caller, and tuning happens via the schema defaults
 * or the wrapper's opts if an ad-hoc run needs it.
 */
async function runDedupPhase(ctx: CycleContext): Promise<CycleResult> {
  let collapsed: number;
  try {
    collapsed = await ctx.supabase.samskaraCollapseByCofiring();
  } catch (err) {
    log.debug('dedup: RPC failed', err);
    return 'error';
  }
  if (collapsed === 0) {
    log.trace('dedup: nothing to collapse');
    return 'empty-phase';
  }
  log.debug('dedup: collapsed samskaras', { collapsed });
  return 'progress';
}

/**
 * Compound-regen. Two-step: check whether we should regen (cheap),
 * then claim+do-the-work (only when the predicate fires). The check
 * RPC takes the role of an idempotency guard - if no work to do,
 * empty-phase and the worker rotates past.
 */
async function runCompoundRegenPhase(ctx: CycleContext): Promise<CycleResult> {
  let decision;
  try {
    decision = await ctx.supabase.samskaraShouldRegenCompound();
  } catch (err) {
    log.debug('compound-regen: shouldRegen RPC failed', err);
    return 'error';
  }
  log.trace('compound-regen: decision', {
    shouldRegen: decision.shouldRegen,
    samskaraCount: decision.samskaraCount,
  });
  if (!decision.shouldRegen) return 'empty-phase';

  let claimed: boolean;
  try {
    claimed = await ctx.supabase.samskaraClaimCompoundRegen(
      ctx.holderId,
      ctx.regenClaimTtlSeconds
    );
  } catch (err) {
    log.debug('compound-regen: claim RPC failed', err);
    return 'error';
  }
  if (!claimed) {
    log.trace('compound-regen: another holder has the claim');
    return 'empty-phase';
  }

  // Read up to log10-capped count for the summary input. Floor at 8
  // so even a tiny corpus produces a coherent paragraph.
  const cap = Math.max(8, Math.ceil(5.0 * Math.log10(decision.samskaraCount + 10)));
  let rows;
  try {
    rows = await ctx.supabase.samskaraTopForSummary(cap);
  } catch (err) {
    log.debug('compound-regen: topForSummary failed', err);
    return 'error';
  }
  if (rows.length === 0) return 'empty-phase';
  // Lifecycle "starting work" line - .info so a compound-regen run
  // is visible in the drawer.
  log.info(
    `compound-regen: synthesizing summary from ${rows.length} sample row(s) ` +
      `(cap ${cap})`
  );

  const summary = await ctx.agent.summarizeCompound(
    rows.map((r) => ({
      prediction: r.prediction,
      inner_voice: r.inner_voice,
      valence: r.valence,
      confidence: r.confidence,
      health: r.health,
    })),
    ctx.signal
  );
  if (!summary) {
    log.debug('compound-regen: agent returned null');
    return 'error';
  }

  try {
    const saved = await ctx.supabase.samskaraSaveCompoundSummary(
      ctx.holderId,
      summary,
      decision.samskaraCount
    );
    if (saved) {
      log.info('compound-regen: saved summary', {
        samskaraCount: decision.samskaraCount,
        chars: summary.length,
      });
    } else {
      log.debug('compound-regen: save rejected (claim expired?)');
    }
    return saved ? 'progress' : 'save-rejected';
  } catch (err) {
    log.debug('compound-regen: save threw', err);
    return 'error';
  }
}

// --- Math helpers --------------------------------------------------------

/**
 * Truncate a string for inline log details. Keeps the drawer
 * readable when a samskara's prediction or a situation summary runs
 * long - the full text is still in the DB, so the log breadcrumb
 * just needs enough to identify which row the line refers to.
 */
function shorten(s: string, max = 80): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}...`;
}

/**
 * Seed-topical cluster for mint-tier1. Takes the recency-ordered
 * substrate window (most-recent first) and returns the seed (row 0)
 * plus the later rows whose situation embedding sits within
 * MINT_CLUSTER_COSINE_FLOOR of the seed, capped at MINT_CLUSTER_MAX and
 * preserving recency order. Rows with no usable embedding (a pgvector
 * parse failure surfaces as an empty array) score cosine -1 and fall
 * out; a seed with no embedding yields a lone-seed cluster the caller
 * rejects against MINT_CLUSTER_MIN.
 */
function buildTopicalCluster(recent: SamskaraSubstrateRow[]): SamskaraSubstrateRow[] {
  const seed = recent[0];
  const seedEmb = seed.situation_embedding as number[];
  const cluster: SamskaraSubstrateRow[] = [seed];
  for (let i = 1; i < recent.length && cluster.length < MINT_CLUSTER_MAX; i++) {
    const emb = recent[i].situation_embedding as number[];
    if (!emb || emb.length === 0) continue;
    if (cosine(seedEmb, emb) >= MINT_CLUSTER_COSINE_FLOOR) {
      cluster.push(recent[i]);
    }
  }
  return cluster;
}

/**
 * Cosine similarity between two equal-length vectors. Used by the
 * pair-relate phase to find the closest substrate neighbour for a
 * seed, and by mint-tier1's topical clustering. Returns -1 if the
 * vectors are zero-norm (defensive, and the signal that a substrate
 * embedding failed to parse - an empty array - shouldn't join a
 * cluster).
 */
function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Tunables for sleep-after-result. */
export interface NapConfig {
  leasePollMs: number;
  /** Sleep when EVERY phase reported empty-phase in a single rotation. */
  idleIntervalMs: number;
  errorBackoffMs: number;
  rateLimitBackoffMs: number;
}

export function napForResult(result: CycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
    case 'progress':
    case 'save-rejected':
      return 0;
    case 'polling':
      return config.leasePollMs;
    case 'empty-phase':
      // Per-phase empty does not idle; it just drains to the next
      // phase. The outer worker accumulates the longest nap across a
      // full rotation and only sleeps when ALL phases reported
      // empty-phase, mirroring the embeddings worker's policy.
      return 0;
    case 'error':
      return config.errorBackoffMs;
    case 'rate-limited':
      return config.rateLimitBackoffMs;
  }
}
