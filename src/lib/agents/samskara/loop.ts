/**
 * Single-cycle driver for the samskara formation worker. The outer
 * loop in `./worker.ts` calls `runOneCycle` repeatedly until abort.
 * Shape mirrors `src/lib/embeddings/loop.ts` and
 * `src/lib/agents/reflection/loop.ts` deliberately — same lease
 * acquire -> claim -> work -> save progression.
 *
 * One cycle = one observable state transition. Unlike the embeddings
 * worker (one source per cycle, round-robin across many in the outer
 * worker), the samskara worker has multiple PHASES per cycle: the
 * outer worker calls runOneCycle once and the cycle internally
 * advances exactly one phase (assimilate / pair-relate /
 * cluster-mint-tier1 / cluster-mint-tier2 / reaction-classify /
 * decay / compound-regen). Phase rotation is round-robin across
 * cycles via the caller's `phaseIndex` state.
 *
 * Why phase rotation in the cycle (vs the worker): the cycle is the
 * unit of test isolation. A test that wants to verify "the assimilate
 * phase claims a row, calls the assimilator, saves, returns
 * 'progress'" can drive that one phase deterministically by passing
 * `phase: 'assimilate'`.
 */
import type { SupabaseService, SamskaraSubstrateRow } from '../../supabase';
import type { VeniceClient } from '../../venice';
import { VeniceError } from '../../venice';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '../../models';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { SamskaraAgent } from './agent';
import { createLogger } from '../../logger.svelte';

// Per-phase decision breadcrumbs. Kept at debug level so the feed is
// cheap to tail while the feature is new and gets filtered out with a
// single dropdown step once the pipeline is trusted. Shared source
// tag with the manager so the Logs drawer groups worker output
// regardless of which file emitted it.
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

/** All worker phases. Iteration order is significant - see PHASES below. */
export type SamskaraPhase =
  | 'assimilate'
  | 'pair-relate'
  | 'mint-tier1'
  | 'mint-tier2'
  | 'reaction-classify'
  | 'decay'
  | 'dedup'
  | 'compound-regen';

/**
 * Phase rotation order. Assimilate runs first because every other
 * phase depends on enriched substrate; pair-relate next because
 * mint depends on association rows; mint-tier1 before mint-tier2
 * because tier 2 depends on tier-1 cohort patterns; reaction-classify
 * is independent and can run any time; decay is cheap; dedup runs
 * after decay so it sees up-to-date health values (a collapsed loser
 * folds its counters into the winner regardless, but scheduling this
 * way means a user looking at the debug panel between phases sees
 * decay-then-merge in that order rather than the reverse); compound-
 * regen runs last so its summary input reflects the freshest tier-2
 * state AND the post-dedup tier-1 pool.
 */
export const PHASES: readonly SamskaraPhase[] = [
  'assimilate',
  'pair-relate',
  'mint-tier1',
  'mint-tier2',
  'reaction-classify',
  'decay',
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
  venice: VeniceClient;
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
      case 'decay':
        return await runDecayPhase(ctx);
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
  log.debug('assimilate: claimed substrate', {
    substrateId: claim.id,
    threadId: claim.threadId,
    userMessageId: claim.userMessageId,
    assistantMessageId: claim.assistantMessageId,
  });

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
  if (!saved) log.debug('assimilate: save rejected (claim expired?)', { substrateId: claim.id });
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
  let recent: SamskaraSubstrateRow[];
  try {
    recent = await ctx.supabase.samskaraRecentEmbeddedSubstrate(40);
  } catch {
    return 'error';
  }
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
    log.debug('pair-relate: no viable pair', {
      candidates: recent.length,
      bestSim: bestSim === -Infinity ? null : bestSim,
    });
    return 'empty-phase';
  }

  const partner = recent[bestIdx];
  log.debug('pair-relate: selected pair', {
    seedId: seed.id,
    partnerId: partner.id,
    cosine: bestSim,
  });
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
  log.debug('pair-relate: associated', {
    aId,
    bId,
    kind: result.kind,
    label: shorten(result.label),
  });
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
  let recent: SamskaraSubstrateRow[];
  try {
    recent = await ctx.supabase.samskaraRecentEmbeddedSubstrate(8);
  } catch (err) {
    log.debug('mint-tier1: substrate fetch failed', err);
    return 'error';
  }
  if (recent.length < 4) {
    log.debug('mint-tier1: insufficient substrate', { have: recent.length, need: 4 });
    return 'empty-phase';
  }

  const cluster = {
    sample_labels: [],
    sample_situations: recent.slice(0, 5).map((r) => r.situation),
    reinforcement: recent.length,
  };
  log.debug('mint-tier1: asking agent', { substrateCount: recent.length });
  const minted = await ctx.agent.mint(cluster, ctx.signal);
  if (!minted) {
    log.debug('mint-tier1: agent declined');
    return 'empty-phase';
  }

  // Embed the prediction so future fire queries can match against it.
  let predEmbedding: number[];
  try {
    const resp = await ctx.venice.embed({
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

  // Dedup guard. The minter agent only sees the five-row substrate
  // sample and has no visibility into the existing samskara corpus,
  // so it cheerfully produces reworded versions of claims that are
  // already present. Query the nearest existing samskara by cosine
  // on `prediction_embedding`; when the similarity exceeds the
  // threshold, reinforce that row (health bump + substrate
  // provenance) instead of minting a twin. A failure of the dedup
  // check itself is non-fatal - we'd rather mint a possible twin
  // than drop a valid signal, and the one-shot collapse RPC is
  // available as a cleanup lane.
  try {
    const nearest = await ctx.supabase.samskaraNearestByPrediction(predEmbedding, 1);
    if (nearest.length > 0 && nearest[0].cosine >= MINT_DEDUP_COSINE) {
      const substrateIds = recent.slice(0, 5).map((r) => r.id);
      await ctx.supabase.samskaraReinforceExisting(
        nearest[0].id,
        substrateIds,
        MINT_DEDUP_HEALTH_BUMP
      );
      log.info('mint-tier1: dedup-reinforced existing', {
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
    // Provenance: link this samskara back to the substrate rows that
    // fed it. ignoreDuplicates handles re-runs cleanly.
    const provRows = recent.slice(0, 5).map((r) => ({
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
 * Mint a tier-2 (compound) samskara from a co-firing cohort pattern.
 * Stub for v1: defers actual cohort-clustering until tier-1 mints are
 * producing real cohorts. Returns empty-phase so the worker rotates
 * past it cheaply.
 */
async function runMintTier2Phase(_ctx: CycleContext): Promise<CycleResult> {
  return 'empty-phase';
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

/** Decay phase. Cheap SQL-only update; one call per cycle. */
async function runDecayPhase(ctx: CycleContext): Promise<CycleResult> {
  try {
    await ctx.supabase.samskaraDecay();
  } catch (err) {
    log.debug('decay: RPC failed', err);
    return 'error';
  }
  log.debug('decay: applied');
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
    log.debug('dedup: nothing to collapse');
    return 'empty-phase';
  }
  log.info('dedup: collapsed samskaras', { collapsed });
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
  log.debug('compound-regen: decision', {
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
    log.debug('compound-regen: another holder has the claim');
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
  log.debug('compound-regen: synthesizing', { rows: rows.length, cap });

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
 * Cosine similarity between two equal-length vectors. Used by the
 * pair-relate phase to find the closest substrate neighbour for a
 * seed. Returns -1 if the vectors are zero-norm (defensive — should
 * never happen for real Venice embeddings).
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
