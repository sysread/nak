// Bias pipeline (function-side port of src/lib/agents/bias/): the
// hourly cron sweep drains two phases in order -
//
//   - analyze: claim a settled thread cross-user via
//     bias_claim_next_thread_for_sweep, run the observer/reactor
//     agent over its transcript, save observations + reactions under
//     the claim guard, stamp bias_processed_at.
//   - aggregate: recompute the per-(user, bias) bias_summary cache
//     for every user the analyze drain touched this tick, plus any
//     user whose cache has aged past the daily freshness floor (the
//     posterior and feedback EMA are age-weighted, so tiers drift
//     even with no new observations).
//
// Cron is the ONLY driver - no chat-turn tail. Analyze eligibility
// requires the thread's last update to fall on a prior calendar day
// in its owner's timezone, so the thread a turn just touched is never
// eligible at turn time; a tail could only do the sweep's job an hour
// early. The browser worker's aggregateDirty / bootstrap-probe /
// throttle machinery all collapsed into this cadence.
//
// Best-effort by contract: one phase failing must not stop the other,
// and nothing here may throw into the sweep handler.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { toolComplete } from '../tools/_venice_complete.ts';
import { BIAS_CATALOG, BIAS_KEYS, isBiasKey } from '../../_shared/bias-catalog.ts';
import {
  aggregatePosterior,
  clampConfidence,
  feedbackEMA,
  CONFIDENCE_CAP,
  CONFIDENCE_FLOOR,
  MIN_USER_MESSAGES,
  type ConversationContribution,
  type FeedbackContribution,
} from '../../_shared/bias-math.ts';

// Mirror of agentModel('bias').id in src/lib/models/index.ts at port
// time - a static role->model map, not a per-user configurable tier,
// so hardcoding stays faithful after the cutover (same approach as
// the curation units).
const BIAS_MODEL = 'mistral-small-3-2-24b-instruct';

// Per-thread claim TTL, seconds. Generous enough that one LLM call
// against a long transcript comfortably fits inside it - the same
// 300s the browser worker passed.
const BIAS_CLAIM_TTL_SECONDS = 300;

/**
 * Per-tick analyze drain cap. Bounds a tick's worst-case Venice spend
 * (one completion per thread); a backlog deeper than the cap drains
 * across successive hourly ticks. The post-port production backlog
 * (~200 threads) takes roughly a day at this rate - deliberate, bias
 * is the least time-critical feature in the app.
 */
const ANALYZE_SWEEP_CAP = 10;

/**
 * Aggregate freshness floor. A user whose oldest bias_summary row is
 * older than this gets recomputed even with no new observations this
 * tick, so age-driven tier drift (recency weights, feedback EMA
 * decay) keeps surfacing.
 */
const SUMMARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Ported VERBATIM from src/lib/agents/bias/prompts.ts (which retired
// with the browser worker) - behavior parity is the QA contract. The
// catalog block renders from the _shared mirror, so a catalog edit
// flows into the prompt the same way it did browser-side.
function renderCatalog(): string {
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(BIAS_CATALOG)) {
    lines.push(`- ${key} - ${entry.label}.`);
    lines.push(`  Definition: ${entry.definition}`);
    lines.push(`  Positive example: ${entry.example}`);
    lines.push(`  Near-miss (NOT this bias): ${entry.nearMiss}`);
    lines.push(`  Compensation guidance: ${entry.guidance}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * System prompt for one bias-observer analysis pass. The user
 * message accompanying this prompt is a JSON object:
 *
 *   {
 *     "messages": [{id, role, content}, ...],
 *     "active_biases": [<catalog key>, ...]
 *   }
 *
 * The full conversation transcript in chronological order, plus
 * the list of biases that were rendered into the system prompt
 * for this conversation. Reactions are reported only for biases
 * in the active_biases list; the catalog is the universe for
 * observations.
 */
const BIAS_OBSERVER_PROMPT = `\
You analyze ONE conversation between a user and an AI assistant and produce two outputs from the same reading:

OBSERVATIONS - cognitive biases or System-1 heuristics the USER (not the assistant) exhibited during this conversation.

REACTIONS - how the user reacted to the assistant's bias-compensated phrasing for any bias that was already in the assistant's system prompt during this conversation. Reactions are only meaningful when there is compensation to react to; the payload's "active_biases" list says which biases the system prompt was actively compensating for.

You see only this one conversation. You never speculate about patterns across other conversations, the user's character, or their general traits. Reporting nothing for both arrays is the correct answer most of the time. Prefer false negatives over false positives - a missed signal today gets caught next conversation; a fabricated signal contaminates aggregate evidence for months.

You may only refer to biases from this fixed catalog. Do not invent new bias names. Use the exact catalog key (lower_snake_case):

${renderCatalog()}

# OBSERVATIONS

## Falsification - before reporting any bias, ask in order

1. Could a reasonable person take this position WITHOUT being subject to this bias? Many positions look superficially like a named bias but are actually defensible reasoning from a different prior. If yes, do not report.

2. Is the user thinking out loud, exploring, hedging, or testing an idea rather than committing to it? Exploratory framing ("what if X", "I wonder whether Y", "playing devil's advocate") is not bias. If yes, do not report.

3. Is this conversation primarily jokes, banter, whimsy, role-play, fiction, or a hypothetical the user posed for fun? Humans suspend disbelief for the sake of compelling play. Calling out a "bias" in someone's bit is pedantic, not helpful. In a playful conversation the standard for reporting is much higher - report ONLY if the user has staked a real factual or decisional position OUTSIDE the playful frame in the same conversation that the bias also applies to.

4. Is the apparent bias confined to suspension-of-disbelief content (writing fiction with you, exploring a thought experiment, building a hypothetical scenario)? Trying on a position is not the same as holding it. If the user is clearly inside a constructed frame, do not report.

5. Am I generalizing from one sentence to a pattern? The cited evidence must be specific to the conversation, not "the user seems like the kind of person who..."

## Observation confidence semantics

- 0.40 (the floor) - "I see something but I am genuinely uncertain whether it is this bias or defensible reasoning"
- 0.50 (default anchor) - "I see it but could reasonably be wrong"
- 0.70 - "I see it clearly, with explicit reasoning from the user that maps to the bias"
- 0.85 (the cap) - "the user stated the biased reasoning in unambiguous terms"

Never report below 0.40 or above 0.85.

# REACTIONS

A reaction classifies how the user responded to the bias-compensation behavior the assistant was performing for an active bias. The compensation guidance the assistant was given for each active bias is listed in the catalog above under "Compensation guidance". Examples of what compensation looks like in practice:

- For confirmation_bias / WYSIATI / black_and_white_thinking: assistant surfaces a contrary view, an alternative framing, or a third option when the user stated a position.
- For anchoring / availability_heuristic / representativeness_heuristic / base_rate_neglect: assistant cites base rates, distributions, or reference classes before estimating specifics.
- For sunk_cost_fallacy / planning_fallacy: assistant reframes the decision on marginal grounds, anchors estimates against typical outcomes for similar projects.
- For affect_heuristic / framing_effect / loss_aversion / negativity_bias: assistant separates emotional reaction from underlying claim, presents loss-and-gain framings symmetrically.
- For overconfidence / hindsight_bias / narrative_fallacy: assistant asks what would change the user's mind, separates known-then from known-now, surfaces alternative explanations.
- For substitution / fundamental_attribution_error / recency_bias: assistant re-states the original question, surfaces situational context, situates a recent event against the longer history.

## How to classify each active bias

For each catalog key in "active_biases", read the conversation and decide:

- "confirmed": the user explicitly or implicitly engaged positively with the compensation behavior. Examples: "good point I hadn't considered", "yeah you're right to question that", "thanks for the alternative", the user updates their position after the assistant's intervention.

- "disconfirmed": the user explicitly or implicitly pushed back on the compensation behavior. Examples: "stop hedging", "just answer the question", "why are you suggesting alternatives", "I don't need devil's-advocate framing", the user gets visibly frustrated with the assistant's pushback or alternative-surfacing.

- "neutral": no clear signal. The user neither engaged with nor pushed back on the compensation; they may have ignored it, accepted it without comment, or the conversation simply did not turn on it. Most conversations land here for most biases. This is the right default when in doubt.

## Reaction falsification - before classifying confirmed or disconfirmed, ask

1. Is the user's reaction specifically to the assistant's compensation behavior, or to something else (a wrong answer, an unrelated tone shift, a request the user actually wanted)? If the pushback is about the assistant's correctness rather than its hedging or alternative-surfacing, classify neutral.

2. Is the user reacting to compensation for THIS specific bias, or generally to the assistant's style? "Stop being so cautious" is generic; "stop suggesting I might be sunk-costing this, I've already decided" is specific. Generic style pushback should not be charged to a specific bias unless the conversation actually turned on that bias.

3. Is this a playful conversation where the user is reacting in character rather than to the assistant's behavior? If the register is comedic / fictional, classify neutral.

4. Does the user's reaction span multiple turns or come from a single off-hand remark? Multi-turn engagement is more reliable than one-shot reactions.

# Output

Return strictly a JSON object of the form:

{"observations": [ ... ], "reactions": [ ... ]}

Each observation:

{
  "bias": "<catalog key>",
  "confidence": <number in [0.40, 0.85]>,
  "evidence_message_id": "<id of the user message that exhibits it>",
  "reasoning": "<one to two sentences citing the specific user message; quote a short phrase>"
}

Each reaction:

{
  "bias": "<catalog key from the active_biases list only>",
  "was_confirmed": true | false | null,
  "reasoning": "<one to two sentences citing what the user said or did; quote a short phrase>"
}

# Empty results are the correct answer most of the time

Return {"observations": [], "reactions": []} when:
- The conversation is short or light (greetings, small-talk, code requests).
- The conversation is playful or fictional and the user has not also staked a factual position outside the frame.
- You see something bias-shaped but the falsification questions ruled it out.

Return reactions: [] when:
- "active_biases" was empty (no compensation was on the wire to react to).
- The conversation did not turn on the active biases.
- You cannot point to a specific user message that affirms or pushes back on the compensation for an active bias.

You may include "neutral" reactions (was_confirmed: null) only when the active_biases list is non-empty and you want to record that you read the transcript and saw no clear signal for that bias. Otherwise omit.

You must return parseable JSON only - no prose preamble, no markdown fence, no trailing commentary. Top-level keys are exactly "observations" and "reactions", each with an array value.`;

// --- Observer/reactor call ------------------------------------------------

interface TranscriptLine {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ObservationItem {
  bias: string;
  confidence: number;
  reasoning: string;
  evidence_message_id: string | null;
}

interface ReactionItem {
  bias: string;
  was_confirmed: boolean | null;
  reasoning: string;
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the prompt's "no markdown fence" instruction - some fast
 * models still wrap structured JSON when their default behaviour
 * leaks through.
 */
function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }
  return trimmed;
}

/**
 * One analysis pass over a conversation: a single completion returns
 * both observations (biases the user exhibited) and reactions (how
 * the user responded to compensation for the active biases). Returns
 * null on parse failure or completion error - the caller leaves the
 * claim to its TTL and the next tick retries.
 *
 * Validation parity with the browser agent: items failing shape
 * checks drop silently (lose one bad item, keep the pass), unknown
 * catalog keys drop, reactions for non-active biases drop as
 * fabrication. Confidence clamping happens in the caller, like the
 * browser split (agent parses, save phase clamps).
 */
async function observeThread(
  apiKey: string,
  transcript: readonly TranscriptLine[],
  activeBiases: readonly string[],
  log: EdgeLogger,
): Promise<{ observations: ObservationItem[]; reactions: ReactionItem[] } | null> {
  const payload = JSON.stringify({
    messages: transcript.map((m) => ({ id: m.id, role: m.role, content: m.content })),
    active_biases: Array.from(activeBiases),
  });

  let raw: string;
  try {
    const result = await toolComplete({
      apiKey,
      model: BIAS_MODEL,
      // Background curation agent: ride out a transient 429 rather than
      // dropping the observation on one "model overloaded".
      retryRateLimit: true,
      messages: [
        { role: 'system', content: BIAS_OBSERVER_PROMPT },
        { role: 'user', content: payload },
      ],
      // Generous - the agent typically emits a small (often empty)
      // object; 4096 covers a long-thread analysis that flags
      // multiple biases with full reasoning. Same cap the browser
      // agent used.
      maxTokens: 4096,
    });
    raw = result.text;
  } catch (err) {
    log.warn(
      `observer completion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  let parsed: { observations?: unknown; reactions?: unknown } | null;
  try {
    parsed = JSON.parse(stripJsonFence(raw)) as {
      observations?: unknown;
      reactions?: unknown;
    };
  } catch {
    parsed = null;
  }
  if (!parsed) return null;
  // Tolerate one of the two top-level keys being missing - partial
  // output is fine; an entirely missing object is a parse failure.
  if (!Array.isArray(parsed.observations) && !Array.isArray(parsed.reactions)) {
    return null;
  }

  const observations: ObservationItem[] = [];
  if (Array.isArray(parsed.observations)) {
    for (const item of parsed.observations) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const bias = typeof o.bias === 'string' ? o.bias : null;
      if (!bias || !isBiasKey(bias)) continue;
      const confidence = typeof o.confidence === 'number' ? o.confidence : null;
      if (confidence === null || Number.isNaN(confidence)) continue;
      const reasoning = typeof o.reasoning === 'string' ? o.reasoning.trim() : '';
      if (reasoning.length === 0) continue;
      const evidenceId =
        typeof o.evidence_message_id === 'string' && o.evidence_message_id.length > 0
          ? o.evidence_message_id
          : null;
      observations.push({
        bias,
        confidence,
        reasoning,
        evidence_message_id: evidenceId,
      });
    }
  }

  // Reactions: the bias must be in the active set - a reaction for a
  // non-active bias is fabrication (no compensation was on the wire
  // for it).
  const activeSet = new Set(activeBiases);
  const reactions: ReactionItem[] = [];
  if (Array.isArray(parsed.reactions)) {
    for (const item of parsed.reactions) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      const bias = typeof r.bias === 'string' ? r.bias : null;
      if (!bias || !isBiasKey(bias)) continue;
      if (!activeSet.has(bias)) continue;
      const reasoning = typeof r.reasoning === 'string' ? r.reasoning.trim() : '';
      if (reasoning.length === 0) continue;
      let wasConfirmed: boolean | null;
      if (r.was_confirmed === true) wasConfirmed = true;
      else if (r.was_confirmed === false) wasConfirmed = false;
      else if (r.was_confirmed === null) wasConfirmed = null;
      else continue;
      reactions.push({ bias, was_confirmed: wasConfirmed, reasoning });
    }
  }

  return { observations, reactions };
}

// --- Analyze phase ----------------------------------------------------------

/** Outcome of one analyze cycle, mirroring the curation units' vocabulary. */
type AnalyzeOutcome =
  /** No claimable thread anywhere - the queue is drained. */
  | 'empty-queue'
  /** Claimed, analyzed, saved (zero observations is a valid save). */
  | 'analyzed'
  /**
   * The save guard fired - a new user message landed during analysis
   * or the claim was stolen. The claim was released; the thread
   * re-enters the queue with fresh state. The queue may hold more.
   */
  | 'save-rejected'
  /** Venice or Supabase errored; stop this tick's drain. */
  | 'error';

/**
 * One sweep step: claim the most-overdue eligible thread across ALL
 * users, analyze it, save under the claim guard. Returns the user_id
 * alongside the outcome so the tick can build its aggregate set. The
 * logger exists only once a claim lands (the claim tells us WHOSE
 * drawer the lines belong in) and is flushed per claim. Non-throwing.
 */
async function sweepClaimAndAnalyze(
  adminClient: SupabaseClient,
): Promise<{ outcome: AnalyzeOutcome; userId: string | null }> {
  const holderId = crypto.randomUUID();
  let claim:
    | { thread_id?: unknown; user_message_count?: unknown; active_biases?: unknown; user_id?: unknown }
    | null;
  try {
    const { data, error } = await adminClient.rpc('bias_claim_next_thread_for_sweep', {
      p_holder_id: holderId,
      p_ttl_seconds: BIAS_CLAIM_TTL_SECONDS,
      p_min_user_messages: MIN_USER_MESSAGES,
    });
    if (error) throw new Error(`bias_claim_next_thread_for_sweep failed: ${error.message}`);
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[bias-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { outcome: 'error', userId: null };
  }
  if (!claim || typeof claim.thread_id !== 'string' || typeof claim.user_id !== 'string') {
    return { outcome: 'empty-queue', userId: null };
  }
  const threadId = claim.thread_id;
  const userId = claim.user_id;
  const expectedMsgCount =
    typeof claim.user_message_count === 'number' ? claim.user_message_count : 0;
  const activeBiases = Array.isArray(claim.active_biases)
    ? claim.active_biases.filter((b): b is string => typeof b === 'string')
    : [];

  const log = createEdgeLogger(userId, 'bias');
  try {
    const outcome = await analyzeClaimedThread(
      adminClient,
      log,
      holderId,
      threadId,
      userId,
      expectedMsgCount,
      activeBiases,
    );
    return { outcome, userId };
  } finally {
    // Flush before the sweep moves on so the outcome line isn't
    // dropped as an un-awaited broadcast when the tick settles.
    await log.flush();
  }
}

/**
 * The work half: the caller already holds the per-thread claim; this
 * fetches the transcript, runs the observer, clamps, and
 * saves-or-rejects. Non-throwing - every failure path folds into an
 * outcome the drain loop can act on.
 */
async function analyzeClaimedThread(
  adminClient: SupabaseClient,
  log: EdgeLogger,
  holderId: string,
  threadId: string,
  userId: string,
  expectedMsgCount: number,
  activeBiases: readonly string[],
): Promise<AnalyzeOutcome> {
  log.info(`analyze: claimed thread ${threadId} (user_messages=${expectedMsgCount})`);

  let apiKey: string | null;
  try {
    apiKey = await readVeniceKey(adminClient);
  } catch {
    apiKey = null;
  }
  if (!apiKey) {
    log.error('no Venice key configured (app_config unseeded)');
    return 'error';
  }

  // Transcript: user + assistant turns with id + content; tool calls
  // and reasoning are not in scope for bias detection. Direct table
  // read - the service role bypasses RLS and the claim already
  // established ownership.
  let transcript: TranscriptLine[];
  try {
    const { data, error } = await adminClient
      .from('messages')
      .select('id, role, content')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    transcript = (data ?? [])
      .filter(
        (m): m is { id: string; role: 'user' | 'assistant'; content: string } =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.length > 0,
      )
      .map((m) => ({ id: m.id, role: m.role, content: m.content }));
  } catch (err) {
    log.warn(
      `analyze: transcript fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'error';
  }

  let cleaned: ObservationItem[] = [];
  let reactions: ReactionItem[] = [];
  if (transcript.length === 0) {
    // Zero-observation saves still stamp bias_processed_at, which
    // moves the denominators in the aggregate math.
    log.debug('analyze: empty transcript, saving zero observations');
  } else {
    const result = await observeThread(apiKey, transcript, activeBiases, log);
    if (result === null) {
      // Parse failure or completion error: leave the claim to its
      // TTL; the thread re-enters the queue next tick.
      log.debug('analyze: observer returned null (parse failure or transient error)');
      return 'error';
    }
    // Clamp confidences before persistence - the DB CHECK matches
    // this range, and the floor drops the agent's "I am not sure"
    // channel so it never becomes data.
    cleaned = result.observations.flatMap((obs) => {
      const c = clampConfidence(obs.confidence, CONFIDENCE_FLOOR, CONFIDENCE_CAP);
      if (c === null) return [];
      return [{ ...obs, confidence: c }];
    });
    reactions = result.reactions;
    log.info(
      `analyze: agent emitted ${result.observations.length} raw obs, ` +
        `${cleaned.length} after floor/cap; ${reactions.length} reaction(s) ` +
        `(thread ${threadId})`,
    );
  }

  try {
    const { data: saved, error } = await adminClient.rpc('bias_save_observations', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_expected_msg_count: expectedMsgCount,
      p_observations: cleaned,
      p_reactions: reactions,
      p_user_id: userId,
    });
    if (error) throw new Error(error.message);
    if (saved !== true) {
      log.debug('analyze: save rejected (claim lost or message count drifted)');
      return 'save-rejected';
    }
  } catch (err) {
    log.warn(
      `analyze: save RPC failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'error';
  }
  log.info(
    `analyze: saved ${cleaned.length} observation(s) and ${reactions.length} reaction(s) ` +
      `for thread ${threadId}`,
  );
  return 'analyzed';
}

// --- Aggregate phase --------------------------------------------------------

/**
 * Recompute every catalog entry's bias_summary row for one user: the
 * two per-bias reads (processed-thread contributions, reaction rows),
 * the math kernel, one upsert per bias. Per-bias failures skip that
 * bias and carry on - a partial recompute catches up next tick.
 * Returns the count of rows written. Non-throwing.
 */
async function aggregateForUser(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<number> {
  let touched = 0;
  const computedAt = new Date().toISOString();
  for (const bias of BIAS_KEYS) {
    let contributions: ConversationContribution[];
    let feedback: FeedbackContribution[] = [];
    try {
      const { data, error } = await adminClient.rpc('bias_processed_threads_for_bias', {
        p_bias: bias,
        p_user_id: userId,
      });
      if (error) throw new Error(error.message);
      const now = Date.now();
      contributions = ((data ?? []) as { processed_at: string; p_conv: number }[]).map(
        (r) => ({
          pConv: r.p_conv,
          ageDays: Math.max(0, (now - new Date(r.processed_at).getTime()) / 86_400_000),
        }),
      );
    } catch (err) {
      log.debug(
        `aggregate: list query failed for ${bias}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    // A reactions failure is non-fatal - aggregate with neutral
    // feedback rather than skipping the bias entirely.
    try {
      const { data, error } = await adminClient.rpc('bias_reactions_for_bias', {
        p_bias: bias,
        p_user_id: userId,
      });
      if (error) throw new Error(error.message);
      feedback = ((data ?? []) as { was_confirmed: boolean | null; age_days: number }[]).map(
        (r) => ({ wasConfirmed: r.was_confirmed, ageDays: r.age_days }),
      );
    } catch (err) {
      log.debug(
        `aggregate: reactions query failed for ${bias} (treating as no signal): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      feedback = [];
    }
    const feedbackScore = feedbackEMA(feedback);
    const post = aggregatePosterior(contributions, { feedbackScore });
    try {
      const { error } = await adminClient.from('bias_summary').upsert(
        {
          user_id: userId,
          bias,
          effective_n: post.effectiveN,
          posterior_alpha: post.alpha,
          posterior_beta: post.beta,
          posterior_mean: post.mean,
          ci_lower: post.ciLower,
          feedback_score: feedbackScore,
          tier: post.tier,
          computed_at: computedAt,
        },
        { onConflict: 'user_id,bias' },
      );
      if (error) throw new Error(error.message);
      touched += 1;
    } catch (err) {
      log.debug(
        `aggregate: upsert failed for ${bias}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  log.info(`aggregate: recomputed ${touched} summary row(s)`);
  return touched;
}

/**
 * Users whose bias_summary cache has aged past the freshness floor.
 * Row volume is tiny (N_users x 19), so the min-per-user fold runs
 * here rather than in a dedicated RPC.
 */
async function staleSummaryUsers(adminClient: SupabaseClient): Promise<string[]> {
  const { data, error } = await adminClient
    .from('bias_summary')
    .select('user_id, computed_at');
  if (error) throw new Error(error.message);
  const oldest = new Map<string, number>();
  for (const row of (data ?? []) as { user_id: string; computed_at: string }[]) {
    const t = new Date(row.computed_at).getTime();
    const prev = oldest.get(row.user_id);
    if (prev === undefined || t < prev) oldest.set(row.user_id, t);
  }
  const cutoff = Date.now() - SUMMARY_MAX_AGE_MS;
  return Array.from(oldest.entries())
    .filter(([, t]) => t < cutoff)
    .map(([userId]) => userId);
}

// --- Sweep tick -------------------------------------------------------------

/** Per-tick tally returned to the sweep route's response/log line. */
export interface BiasSweepSummary {
  analyzed: number;
  usersAggregated: number;
}

/**
 * One cron sweep tick: drain the analyze queue cross-user up to the
 * per-tick cap, then recompute summaries for every user touched plus
 * any user past the freshness floor. Non-throwing.
 */
export async function runBiasSweepTick(
  adminClient: SupabaseClient,
): Promise<BiasSweepSummary> {
  const touchedUsers = new Set<string>();
  let analyzed = 0;
  let drained = 0;
  let stillDraining = true;
  while (drained < ANALYZE_SWEEP_CAP) {
    const { outcome, userId } = await sweepClaimAndAnalyze(adminClient);
    drained++;
    if (outcome === 'analyzed') {
      analyzed++;
      if (userId) touchedUsers.add(userId);
    }
    // 'save-rejected' consumed a claim (released it with fresh state
    // pending) - the queue may hold more, keep draining. Errors stop
    // the drain; the next hourly tick retries.
    if (outcome !== 'analyzed' && outcome !== 'save-rejected') {
      stillDraining = false;
      break;
    }
  }
  // No silent caps: a queue that hits the cap every tick is growing
  // faster than the sweep drains it and someone should notice.
  if (stillDraining && drained >= ANALYZE_SWEEP_CAP) {
    console.log(
      `[bias-sweep] analyze cap (${ANALYZE_SWEEP_CAP}) reached with threads still pending`,
    );
  }

  // Aggregate set: touched this tick + cache past the daily floor.
  const aggregateUsers = new Set(touchedUsers);
  try {
    for (const userId of await staleSummaryUsers(adminClient)) {
      aggregateUsers.add(userId);
    }
  } catch (err) {
    // Stale-scan failure degrades to touched-only aggregation; the
    // floor catches up on a later tick.
    console.error(
      '[bias-sweep] stale-summary scan failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  let usersAggregated = 0;
  for (const userId of aggregateUsers) {
    const log = createEdgeLogger(userId, 'bias');
    try {
      await aggregateForUser(adminClient, userId, log);
      usersAggregated++;
    } catch (err) {
      // aggregateForUser is non-throwing by contract; this guard
      // keeps a contract violation from starving the users after it.
      log.error(
        'aggregate pass failed',
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      await log.flush();
    }
  }

  return { analyzed, usersAggregated };
}

// Test-only surface: prompt rendering (the catalog must be embedded)
// and the tick's caps get asserted in
// supabase/functions/tests/bias.test.ts.
export const __test = {
  BIAS_OBSERVER_PROMPT,
  ANALYZE_SWEEP_CAP,
  SUMMARY_MAX_AGE_MS,
  observeThread,
};
