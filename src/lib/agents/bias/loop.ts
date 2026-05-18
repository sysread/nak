/**
 * Single-cycle driver for the bias-observer worker. The outer loop in
 * `./worker.ts` calls `runOneCycle` repeatedly until abort. Shape
 * mirrors `src/lib/agents/samskara/loop.ts` exactly - same lease
 * acquire -> claim -> agent -> save progression - so the worker
 * infrastructure across features stays uniform.
 *
 * Two phases per rotation:
 *
 *   - `analyze`: claim the next eligible thread, fetch its
 *     transcript, run the observer agent, save the observations
 *     under the claim guard. The claim+save protocol survives a
 *     mid-analysis new user message: the save RPC checks the
 *     expected user-message count and drops the save (without
 *     persisting anything) if a new message landed during
 *     analysis. The thread becomes re-eligible on the next pass.
 *
 *   - `aggregate`: recompute `bias_summary` for every catalog
 *     entry. Cheap: one query + JS math per bias. Always runs once
 *     per rotation so the chat-loop's read of the cache is never
 *     more than a rotation stale. If no observations exist for a
 *     bias yet, the recomputed row reflects the prior alone
 *     (Beta(2, 8)) and tiers as 'elided'.
 *
 * Rotation order: aggregate first, analyze second. That way a
 * fresh cycle catches up on the cache even when there's nothing
 * to analyze, which keeps the chat-loop read warm. The
 * dependency goes one way - aggregate reads what analyze writes -
 * but rotation order matters mainly for the cold-start case.
 */
import type { SupabaseService } from '../../supabase';
import type { VeniceClient } from '../../venice';
import { VeniceError } from '../../venice';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { BiasObserverAgent, TranscriptLine } from './agent';
import { createLogger } from '../../logger.svelte';
import {
  CONFIDENCE_CAP,
  CONFIDENCE_FLOOR,
  MIN_USER_MESSAGES,
} from '../../bias/types';
import {
  aggregatePosterior,
  clampConfidence,
  feedbackEMA,
  type ConversationContribution,
  type FeedbackContribution,
} from '../../bias/math';
import { BIAS_KEYS } from '../../bias/catalog';

const log = createLogger('bias-worker');

export type BiasPhase = 'aggregate' | 'analyze';

/**
 * Phase order. Aggregate first so the chat-loop's cached read stays
 * warm even when the analyze phase has nothing to do; analyze
 * second so a brand-new save triggers a same-rotation aggregate on
 * the NEXT rotation (the current rotation's aggregate already ran).
 */
export const PHASES: readonly BiasPhase[] = ['aggregate', 'analyze'];

export type CycleResult =
  /** Just took the lease. Caller recurses immediately. */
  | 'acquired-lease'
  /** Someone else holds the lease. Polling. */
  | 'polling'
  /** Phase had nothing to do this rotation. */
  | 'empty-phase'
  /** Phase ran the agent / aggregation and committed. */
  | 'progress'
  /** Phase ran but the save guard fired (claim lost, message count
   *  mismatched). Drain to next phase. */
  | 'save-rejected'
  /** Venice rate-limited. Long back-off. */
  | 'rate-limited'
  /** Transient Venice / Supabase error. Short back-off. */
  | 'error';

export interface CycleContext {
  agent: BiasObserverAgent;
  supabase: SupabaseService;
  venice: VeniceClient;
  coordinator: LeaseCoordinator;
  holderId: string;
  /** Per-thread claim TTL, seconds. Generous enough that one LLM
   *  call comfortably fits inside it. */
  claimTtlSeconds: number;
  /** Phase to advance this cycle. */
  phase: BiasPhase;
  signal: AbortSignal;
  onLeaseLost: () => void;
  /** Set of conversation ids the user has open in this app
   *  instance. We don't analyze a thread the user might still be
   *  typing in. Updated by the manager via postMessage; defaults
   *  to empty. */
  excludeThreadIds: () => readonly string[];
}

export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'empty-phase';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) return 'polling';
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    return 'acquired-lease';
  }

  try {
    switch (ctx.phase) {
      case 'analyze':
        return await runAnalyzePhase(ctx);
      case 'aggregate':
        return await runAggregatePhase(ctx);
    }
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') return 'rate-limited';
    return 'error';
  }
}

// --- Phase implementations ----------------------------------------------

/**
 * Analyze phase. Claims one eligible thread, fetches messages,
 * calls the observer agent, runs each observation through the
 * confidence floor/cap, and saves under the claim guard.
 */
async function runAnalyzePhase(ctx: CycleContext): Promise<CycleResult> {
  let claim;
  try {
    claim = await ctx.supabase.biasClaimNextThread(
      ctx.holderId,
      ctx.claimTtlSeconds,
      ctx.excludeThreadIds(),
      todayStartUtc(),
      MIN_USER_MESSAGES
    );
  } catch (err) {
    log.debug('analyze: claim RPC failed', err);
    return 'error';
  }
  if (!claim) {
    log.trace('analyze: no eligible threads');
    return 'empty-phase';
  }
  // Lifecycle headline parallel to samskara's "picked up X" - .info
  // so a developer watching the drawer at the default level can see
  // the worker actually picking up work.
  log.info(
    `analyze: claimed thread ${claim.threadId} ` +
      `(user_messages=${claim.userMessageCount})`
  );

  // Fetch the transcript. We give the agent only user + assistant
  // turns with id + content; tool calls and reasoning content are
  // not in scope for bias detection.
  let messages;
  try {
    messages = await ctx.supabase.listMessages(claim.threadId);
  } catch (err) {
    log.debug('analyze: listMessages failed', err);
    return 'error';
  }
  const transcript: TranscriptLine[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!m.content || m.content.length === 0) continue;
    transcript.push({ id: m.id, role: m.role, content: m.content });
  }
  if (transcript.length === 0) {
    log.debug('analyze: empty transcript, saving zero observations');
    const ok = await ctx.supabase.biasSaveObservations(
      claim.threadId,
      ctx.holderId,
      claim.userMessageCount,
      [],
      []
    );
    return ok ? 'progress' : 'save-rejected';
  }

  const result = await ctx.agent.observe(transcript, claim.activeBiases, ctx.signal);
  if (result === null) {
    log.debug('analyze: agent returned null (parse failure or transient error)');
    return 'error';
  }

  // Per-observation debug breadcrumbs. Each observation the agent
  // emitted gets a line with the bias key, the raw confidence the
  // agent reported (pre-clamp), and the reasoning string. The
  // logger truncates very long messages naturally; the reasoning
  // text is two sentences max per the agent's prompt, so the line
  // stays readable in the drawer.
  if (result.observations.length === 0) {
    log.debug(`analyze: agent reported no biases for thread ${claim.threadId}`);
  } else {
    for (const obs of result.observations) {
      log.debug(
        `analyze: ${obs.bias} (conf ${obs.confidence.toFixed(2)}) - ${obs.reasoning}`
      );
    }
  }
  // Per-reaction debug breadcrumbs. The reactor only runs when the
  // active set is non-empty; on the empty-set path the agent
  // returns no reactions and we skip the log line.
  if (claim.activeBiases.length > 0) {
    if (result.reactions.length === 0) {
      log.debug(`analyze: agent reported no reactions for thread ${claim.threadId}`);
    } else {
      for (const r of result.reactions) {
        const verdict =
          r.wasConfirmed === true
            ? 'confirmed'
            : r.wasConfirmed === false
              ? 'disconfirmed'
              : 'neutral';
        log.debug(`analyze: reaction ${r.bias} -> ${verdict} - ${r.reasoning}`);
      }
    }
  }

  // Clamp confidences before persistence. The DB has a CHECK
  // constraint matching this range, so a missed clamp would surface
  // as a 23514 violation; the floor/cap here also drops sub-floor
  // entries (the agent's "I am not sure" channel) so they never
  // become data.
  const cleaned: {
    bias: string;
    confidence: number;
    reasoning: string;
    evidence_message_id: string | null;
  }[] = [];
  for (const obs of result.observations) {
    const c = clampConfidence(obs.confidence, CONFIDENCE_FLOOR, CONFIDENCE_CAP);
    if (c === null) continue;
    cleaned.push({
      bias: obs.bias,
      confidence: c,
      reasoning: obs.reasoning,
      evidence_message_id: obs.evidenceMessageId,
    });
  }
  // Reactions don't need a floor/cap - they're three-state, not
  // numeric. The agent's parser already restricted bias to the
  // active set and dropped malformed items; the worker passes the
  // list straight through.
  const reactions = result.reactions.map((r) => ({
    bias: r.bias,
    was_confirmed: r.wasConfirmed,
    reasoning: r.reasoning,
  }));

  log.info(
    `analyze: agent emitted ${result.observations.length} raw obs, ` +
      `${cleaned.length} after floor/cap; ${result.reactions.length} reaction(s) ` +
      `(thread ${claim.threadId})`
  );
  let saved: boolean;
  try {
    saved = await ctx.supabase.biasSaveObservations(
      claim.threadId,
      ctx.holderId,
      claim.userMessageCount,
      cleaned,
      reactions
    );
  } catch (err) {
    log.debug('analyze: save RPC failed', err);
    return 'error';
  }
  if (!saved) {
    log.debug('analyze: save rejected (claim lost or message count drifted)');
    return 'save-rejected';
  }
  log.info(
    `analyze: saved ${cleaned.length} observation(s) and ${reactions.length} reaction(s) ` +
      `for thread ${claim.threadId}`
  );
  return 'progress';
}

/**
 * Aggregate phase. For every catalog entry, query the per-bias
 * processed-thread contributions, run the math, upsert one
 * `bias_summary` row. Cheap; happens every rotation regardless of
 * whether analyze produced new work.
 *
 * "Empty-phase" semantics: the rotation reports empty when every
 * bias's recomputed row is identical to the cached row (within
 * float tolerance). In practice this means "nothing observable
 * changed", and the outer worker's idle-sleep heuristic counts that
 * as quiescent. Achieving identical-up-to-eps detection requires a
 * round-trip per bias to read the prior row; cheaper to always
 * return 'progress' here and let the idle sleep come from the
 * analyze phase being repeatedly empty. The aggregate side runs in
 * milliseconds.
 */
async function runAggregatePhase(ctx: CycleContext): Promise<CycleResult> {
  let touched = 0;
  for (const bias of BIAS_KEYS) {
    if (ctx.signal.aborted) return 'progress';
    let contributions: ConversationContribution[];
    let feedback: FeedbackContribution[] = [];
    try {
      const rows = await ctx.supabase.biasProcessedThreadsForBias(bias);
      const now = Date.now();
      contributions = rows.map((r) => ({
        pConv: r.pConv,
        ageDays: Math.max(0, (now - new Date(r.processedAt).getTime()) / 86_400_000),
      }));
    } catch (err) {
      log.debug('aggregate: list query failed', { bias, err });
      // Don't fail the whole rotation for one bias; carry on.
      continue;
    }
    // Compensation-feedback EMA. A failure here is non-fatal -
    // we'd rather aggregate with neutral feedback than skip the
    // bias entirely. Treat any error as "no reactions" and keep
    // going.
    try {
      const reactionRows = await ctx.supabase.biasReactionsForBias(bias);
      feedback = reactionRows.map((r) => ({
        wasConfirmed: r.wasConfirmed,
        ageDays: r.ageDays,
      }));
    } catch (err) {
      log.debug('aggregate: reactions query failed (treating as no signal)', { bias, err });
      feedback = [];
    }
    const feedbackScore = feedbackEMA(feedback);
    const post = aggregatePosterior(contributions, { feedbackScore });
    try {
      await ctx.supabase.biasUpsertSummary({
        bias,
        effectiveN: post.effectiveN,
        posteriorAlpha: post.alpha,
        posteriorBeta: post.beta,
        posteriorMean: post.mean,
        ciLower: post.ciLower,
        feedbackScore,
        tier: post.tier,
      });
      touched += 1;
    } catch (err) {
      log.debug('aggregate: upsert failed', { bias, err });
    }
  }
  log.trace(`aggregate: recomputed ${touched} summary row(s)`);
  // Even when no observations exist, the prior-only rows still
  // need writing so the cache is queryable.
  return touched > 0 ? 'progress' : 'empty-phase';
}

/**
 * Midnight at the start of "today" in the user's local time, as a
 * UTC instant. Web Workers inherit the host browser's system
 * timezone via the Intl API, which matches the user's device clock
 * - same wall the chat-loop reads "today" against. We pass the UTC
 * instant rather than a date string so the SQL gate can compare
 * directly against threads.updated_at (a timestamptz).
 *
 * Why not the user's configured `displayTimezone` setting: the
 * exclusion semantics are "the user is plausibly still chatting on
 * this thread today" which is a clock-on-the-wall question. The
 * display timezone affects rendering, not when the user is awake.
 * If a user travels and changes their setting, "today" still means
 * "the calendar day of the device they are holding."
 */
function todayStartUtc(): Date {
  // Format-and-reparse trick: get YYYY-MM-DD in the local zone,
  // then construct a Date at the START of that day using the
  // Date(year, month, day) constructor (which interprets in local
  // tz). Convert to a UTC instant for the SQL comparison.
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

// --- Nap config ----------------------------------------------------------

export interface NapConfig {
  leasePollMs: number;
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
      // Drain to next phase; the outer worker sleeps only when
      // every phase reported empty.
      return 0;
    case 'error':
      return config.errorBackoffMs;
    case 'rate-limited':
      return config.rateLimitBackoffMs;
  }
}
