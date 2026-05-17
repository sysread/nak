/**
 * Shared types and tunable constants for the bias-profile feature.
 *
 * The chat-loop side imports `BiasSummaryRow` and `Tier` from here so
 * its readers don't pull in the Supabase/Venice surface; the worker
 * side imports the same types so the formation pipeline and the
 * chat-loop integration agree on what an aggregated bias row looks
 * like.
 *
 * Why a separate types module rather than re-exporting from
 * `./index.ts`: index.ts pulls Supabase and the model registry, and
 * we don't want every consumer of a type (the worker, tests, the
 * debug modal) to drag those imports along.
 */
import type { BiasKey } from './catalog';

/**
 * Aggregate row per (user_id, bias). Mirrors `public.bias_summary`
 * with camelCased fields for in-app consumption. The chat-loop
 * format pass reads only the soft+strong rows.
 */
export interface BiasSummaryRow {
  bias: BiasKey;
  /** Sum of recency weights. The "effective sample size" - real
   *  weighted count of processed conversations, including those
   *  that did NOT exhibit this bias. */
  effectiveN: number;
  /** Beta posterior alpha = prior + sum(w_i * p_conv_B). */
  posteriorAlpha: number;
  /** Beta posterior beta = prior + sum(w_i * (1 - p_conv_B)). */
  posteriorBeta: number;
  /** alpha / (alpha + beta). Posterior point estimate. */
  posteriorMean: number;
  /** 90% one-sided credible interval lower bound from the inverse
   *  regularized incomplete beta. Surfacing gate. */
  ciLower: number;
  /** Render-time tier from N_eff floor + ciLower thresholds. */
  tier: Tier;
  /** Wall-clock when this row was last recomputed by the worker. */
  computedAt: string;
}

/**
 * One observation written by the bias-observer agent. Mirrors
 * `public.bias_observations` rows in camelCase.
 */
export interface BiasObservation {
  id: string;
  threadId: string;
  bias: BiasKey;
  /** Post-floor, post-cap; the worker clamps before insert so DB
   *  rows always satisfy the [0.40, 0.85] check constraint. */
  confidence: number;
  reasoning: string;
  /** Optional pointer back to the user message that exhibits the
   *  bias. Nullable because messages can be deleted; the
   *  observation survives the message it cited. */
  evidenceMessageId: string | null;
  createdAt: string;
}

/**
 * Three-way surfacing tier. `elided` means the section is absent
 * from the system prompt entirely - no placeholder text, no "no
 * data yet" note (same convention samskara's compound summary uses
 * for its null state).
 */
export type Tier = 'elided' | 'soft' | 'strong';

/**
 * Hard-coded math tunables. Lifted out of the schema layer so
 * changing them doesn't require a `mise run sync`; the worker
 * recomputes the cache on its next cycle. See docs/dev/bias-profile.md
 * for the rationale on each value.
 *
 *   ALPHA_PRIOR / BETA_PRIOR — Beta(2, 8). Mean 0.2, equivalent to
 *   10 pseudo-conversations at the base rate. Carries the law-of-
 *   small-numbers protection: the first handful of real
 *   observations can't move the posterior far.
 *
 *   HALF_LIFE_DAYS — exponential recency decay. 60 days halves the
 *   weight of an observation that old. User habits change slowly
 *   but not infinitely slowly.
 *
 *   N_EFF_FLOOR — minimum sum of recency weights before any bias
 *   can leave the elided tier. Even if every observation is at
 *   confidence 0.85, fewer than five effective conversations is
 *   not a pattern.
 *
 *   CI_LB_SOFT / CI_LB_STRONG — surfacing thresholds on the lower
 *   bound of the 90% credible interval. Lower bound (not mean) so
 *   the gate combines "high estimate" AND "enough data to be sure
 *   it's high."
 *
 *   CONFIDENCE_FLOOR / CONFIDENCE_CAP — clamp incoming observation
 *   confidences before they enter the math. Below the floor is the
 *   agent's "I'm genuinely unsure" channel; above the cap
 *   acknowledges that LLM confidences are not calibrated.
 *
 *   PER_CONV_CAP — ceiling on the noisy-OR-collapsed probability
 *   for one conversation. Repeated same-bias hits from the same
 *   agent on the same pass are correlated signals; without this
 *   cap noisy-OR races past the calibration ceiling.
 *
 *   RENDER_CAP — max biases rendered into the system-prompt block.
 *   Above this, the bullets crowd out the actual instruction
 *   surface. The debug modal shows all clearing biases regardless.
 */
export const ALPHA_PRIOR = 2;
export const BETA_PRIOR = 8;
export const HALF_LIFE_DAYS = 60;
export const N_EFF_FLOOR = 5;
export const CI_LB_SOFT = 0.15;
export const CI_LB_STRONG = 0.30;
export const CONFIDENCE_FLOOR = 0.40;
export const CONFIDENCE_CAP = 0.85;
export const PER_CONV_CAP = 0.85;
export const RENDER_CAP = 4;

/**
 * Minimum user-message count on a thread before the worker
 * considers it. The user wants two-plus user messages so we have
 * an actual back-and-forth, not a one-shot ping. Matches the
 * spec.
 */
export const MIN_USER_MESSAGES = 2;
