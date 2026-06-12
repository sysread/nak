// Pure math for bias aggregation - the server-side home, fed by the
// venice function's bias-sweep aggregate pass. MOVED from
// src/lib/bias/math.ts when the browser bias worker retired (the
// browser runs no bias math; the modal and chat path only read the
// bias_summary rows this math produces). Self-contained (no relative
// imports) so the Deno island, vitest (tests/bias-math.test.ts), and
// tsc can all load it.
//
// The tuning constants below MIRROR src/lib/bias/types.ts, where the
// BiasProfile screen reads the same values for display.
// tests/bias-catalog-parity.test.ts compares the two sides - a
// one-sided edit fails the gate.
//
// Pipeline shape (computed per (user_id, bias) by the aggregate
// pass):
//
//   1. For each processed conversation, collapse same-bias
//      observations within it via noisy-OR, then cap at PER_CONV_CAP
//      (the per-conversation ceiling matches the per-observation
//      ceiling because repeated finds by the same agent on the same
//      pass are correlated signals, not independent ones).
//
//   2. Across all processed conversations (including those that did
//      NOT exhibit the bias - those contribute (1 - 0) on the beta
//      side), apply an exponential recency weight with half-life of
//      HALF_LIFE_DAYS, and accumulate into a weighted Beta-Binomial
//      posterior: alpha = ALPHA_PRIOR + sum(w * p), beta = BETA_PRIOR
//      + sum(w * (1 - p)).
//
//   3. Compute the 90% one-sided credible interval lower bound via
//      the inverse regularized incomplete beta function. Normal-
//      approximation alternatives (mean - 1.2816 * sd) consistently
//      overstate uncertainty in the small-alpha/beta regime where we
//      live for the first dozen conversations, which silently
//      suppresses real signal. The exact routine here is ~150 lines
//      of numerical code and adds no external dependency. At very
//      large samples (alpha + beta > ~200) the normal approximation
//      becomes accurate enough to swap in for speed; not worth doing
//      until then.
//
//   4. Tier the result by N_eff floor + ciLower thresholds.
//
// See docs/dev/bias-profile.md for the rationale behind each
// constant.

/** Tier vocabulary for bias_summary rows. Mirror of src/lib/bias/types.ts. */
export type Tier = 'elided' | 'soft' | 'strong';

// Tuning constants - mirrors of src/lib/bias/types.ts; see the prose
// there (and docs/dev/bias-profile.md) for each value's rationale.
export const ALPHA_PRIOR = 2;
export const BETA_PRIOR = 8;
export const HALF_LIFE_DAYS = 60;
export const N_EFF_FLOOR = 5;
export const CI_LB_SOFT = 0.15;
export const CI_LB_STRONG = 0.30;
export const CONFIDENCE_FLOOR = 0.40;
export const CONFIDENCE_CAP = 0.85;
export const PER_CONV_CAP = 0.85;
export const MIN_USER_MESSAGES = 2;
export const FEEDBACK_HALF_LIFE_DAYS = 30;
export const FEEDBACK_THRESHOLD_DELTA = 0.10;
export const FEEDBACK_PRIOR_WEIGHT = 3;

/**
 * Combine multiple same-bias observations within ONE conversation
 * into a single probability that the conversation exhibits the bias.
 * Noisy-OR: independent signals of the same underlying fact. The
 * cap (PER_CONV_CAP) acknowledges that observations from the same
 * agent in the same pass are correlated rather than independent;
 * without it a single conversation with three confidence-0.7 hits
 * would race past our overall calibration ceiling.
 *
 * Returns 0 when the input is empty - the "this conversation did
 * not exhibit the bias" answer.
 */
export function collapseWithinConversation(confidences: readonly number[]): number {
  if (confidences.length === 0) return 0;
  let q = 1;
  for (const c of confidences) {
    q *= 1 - c;
  }
  const p = 1 - q;
  return p > PER_CONV_CAP ? PER_CONV_CAP : p;
}

/**
 * Exponential recency weight. Half-life of HALF_LIFE_DAYS days; an
 * observation that age has half the influence of one made today.
 * Caller is responsible for computing ageDays correctly in the
 * user's local timezone (or as a wall-clock difference - within an
 * order of magnitude of "days" the unit choice doesn't matter for
 * the math).
 */
export function recencyWeight(ageDays: number, halfLife: number = HALF_LIFE_DAYS): number {
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLife);
}

/**
 * One processed conversation's contribution to the posterior. The
 * worker passes one of these per conversation that contains at
 * least one observation of the bias being aggregated; conversations
 * that processed-but-no-observation are passed with `pConv = 0`.
 */
export interface ConversationContribution {
  pConv: number;
  ageDays: number;
}

/**
 * One reaction's contribution to the feedback EMA. Neutral
 * reactions (wasConfirmed === null) are filtered out by the EMA
 * helper rather than coerced to a numeric mid-point - the prior
 * pseudo-count already carries that "no signal" weight, and
 * counting neutrals would double-dampen the score.
 */
export interface FeedbackContribution {
  wasConfirmed: boolean | null;
  ageDays: number;
}

/**
 * Posterior summary, ready to write to bias_summary. Mirrors the
 * BiasSummaryRow row shape but without the catalog key (the caller
 * already knows what bias this is).
 */
export interface PosteriorSummary {
  alpha: number;
  beta: number;
  effectiveN: number;
  mean: number;
  ciLower: number;
  tier: Tier;
}

/**
 * Build the Beta-Binomial posterior from a list of per-conversation
 * probabilities + ages. The caller is responsible for including
 * non-observed conversations as `pConv = 0` so the denominator is
 * the full processed set, not just the hits - without that the rate
 * estimate collapses to 1.0 immediately.
 *
 * `feedbackScore` shifts the surfacing thresholds in `tier()` and
 * defaults to 0 (no shift) so callers that don't yet thread the
 * compensation-feedback EMA produce identical output to the v1
 * pipeline.
 */
export function aggregatePosterior(
  contributions: readonly ConversationContribution[],
  opts: {
    alphaPrior?: number;
    betaPrior?: number;
    halfLife?: number;
    feedbackScore?: number;
  } = {}
): PosteriorSummary {
  const alphaPrior = opts.alphaPrior ?? ALPHA_PRIOR;
  const betaPrior = opts.betaPrior ?? BETA_PRIOR;
  const halfLife = opts.halfLife ?? HALF_LIFE_DAYS;
  const feedbackScore = opts.feedbackScore ?? 0;

  let alpha = alphaPrior;
  let beta = betaPrior;
  let effectiveN = 0;
  for (const { pConv, ageDays } of contributions) {
    const w = recencyWeight(ageDays, halfLife);
    alpha += w * pConv;
    beta += w * (1 - pConv);
    effectiveN += w;
  }

  const mean = alpha / (alpha + beta);
  const ciLower = betaInv(0.10, alpha, beta);
  const t = tier(effectiveN, ciLower, feedbackScore);
  return { alpha, beta, effectiveN, mean, ciLower, tier: t };
}

/**
 * Tier rule. Both gates must pass for a non-elided tier - a high
 * ciLower with low N_eff means the math thinks the rate could be
 * high but does not have enough data to commit, and vice-versa.
 * The floor on N_eff is what protects against law-of-small-numbers
 * in the early-data regime where the prior is no longer the only
 * mass but the data is still thin.
 *
 * `feedbackScore` in [-1, +1] shifts the CI gates symmetrically by
 * up to FEEDBACK_THRESHOLD_DELTA. Affirming users get more
 * sensitive thresholds (more biases surface); pushing-back users
 * get less sensitive thresholds (fewer biases surface). The math
 * kernel does not touch the underlying posterior; the EMA just
 * nudges where the gate sits. Defaults to 0 so callers that
 * haven't wired feedback through yet behave identically.
 */
export function tier(
  effectiveN: number,
  ciLower: number,
  feedbackScore: number = 0
): Tier {
  if (effectiveN < N_EFF_FLOOR) return 'elided';
  // Clamp feedbackScore to [-1, +1] so a caller passing a raw EMA
  // that briefly exceeds the bounds via numerical drift cannot push
  // the gate past its intended envelope.
  const fs = Math.max(-1, Math.min(1, feedbackScore));
  const softGate = CI_LB_SOFT - FEEDBACK_THRESHOLD_DELTA * fs;
  const strongGate = CI_LB_STRONG - FEEDBACK_THRESHOLD_DELTA * fs;
  if (ciLower <= softGate) return 'elided';
  if (ciLower <= strongGate) return 'soft';
  return 'strong';
}

/**
 * Compensation-feedback EMA in [-1, +1] from a list of reaction
 * rows. Weighted exponential decay with FEEDBACK_HALF_LIFE_DAYS;
 * neutral reactions (wasConfirmed === null) are skipped entirely
 * rather than weighted as 0, because the prior pseudo-count
 * (FEEDBACK_PRIOR_WEIGHT neutrals) already carries the "no signal"
 * mass and double-counting would over-dampen.
 *
 * Empty input returns 0 (no signal) - the prior is the only mass.
 * Caller treats 0 as "use unshifted thresholds."
 */
export function feedbackEMA(
  reactions: readonly FeedbackContribution[]
): number {
  let weightedSum = 0;
  let totalWeight = FEEDBACK_PRIOR_WEIGHT;
  for (const { wasConfirmed, ageDays } of reactions) {
    if (wasConfirmed === null) continue;
    const w = recencyWeight(ageDays, FEEDBACK_HALF_LIFE_DAYS);
    weightedSum += w * (wasConfirmed ? 1 : -1);
    totalWeight += w;
  }
  return weightedSum / totalWeight;
}

// --- Inverse regularized incomplete beta -----------------------------------
//
// betaInv(p, a, b) returns x such that I_x(a, b) = p where I is the
// regularized incomplete beta function. This is the inverse CDF of
// Beta(a, b). Used here for credible interval lower bounds.
//
// Implementation is the standard "Newton-Halley on the log-beta-CDF
// with bracket fallback" recipe (see Press et al., Numerical Recipes
// 3e, sec. 6.4). Adapted to TypeScript; no external dependency. The
// regularized incomplete beta itself is computed via the
// continued-fraction expansion (Lentz's algorithm). Tested for
// numerical agreement with Python's scipy.stats.beta.ppf to within
// 1e-6 over the parameter ranges this feature uses.

/**
 * Logarithm of the gamma function. Stirling-style approximation with
 * Lanczos coefficients, accurate to ~1e-12 over the positive reals.
 */
function lgamma(x: number): number {
  // Lanczos coefficients g=7, n=9. Public-domain reference values.
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection: lgamma(1 - x) = log(pi / (sin(pi x) * gamma(x)))
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  const y = x - 1;
  let sum = c[0];
  for (let i = 1; i < g + 2; i++) {
    sum += c[i] / (y + i);
  }
  const t = y + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(sum);
}

/**
 * Logarithm of the beta function. B(a, b) = gamma(a)*gamma(b)/gamma(a+b).
 */
function lbeta(a: number, b: number): number {
  return lgamma(a) + lgamma(b) - lgamma(a + b);
}

/**
 * Continued-fraction core for the regularized incomplete beta.
 * Two CF terms per loop iteration, matching the Numerical Recipes
 * 3e `betacf` reference exactly so the algorithm structure is
 * cross-checkable against a known-good source. Caller is responsible
 * for the prefactor and the symmetry flip.
 */
function betacf(a: number, b: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-15;
  const fpmin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    // Even step: numerator d_{2m}.
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    // Odd step: numerator d_{2m+1}.
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

/**
 * Regularized incomplete beta function I_x(a, b). Continued-fraction
 * convergence is fast only when x < (a+1)/(a+b+2); the symmetry
 * I_x(a, b) = 1 - I_{1-x}(b, a) flips the call onto the fast side
 * when the input falls on the slow side. Returns NaN for invalid
 * inputs.
 */
function regIncBeta(x: number, a: number, b: number): number {
  if (Number.isNaN(x) || Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - regIncBeta(1 - x, b, a);
  // Prefactor: x^a * (1-x)^b / (a * B(a, b))
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta(a, b)) / a;
  return front * betacf(a, b, x);
}

/**
 * Inverse of the regularized incomplete beta. Returns x such that
 * I_x(a, b) = p. Bracket search refined by Newton with bisection
 * fallback; this is the inverse-CDF of Beta(a, b).
 *
 * Exposed for tests; consumers should use `aggregatePosterior` which
 * calls this once per aggregation.
 */
export function betaInv(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (a <= 0 || b <= 0) return Number.NaN;
  // Initial guess: Cornish-Fisher-style approximation. Works well
  // for moderate (a, b); the bracket fallback handles edge cases.
  const mean = a / (a + b);
  let x = mean;
  if (a > 1 && b > 1) {
    // Wilson-Hilferty: Beta is approx normal in the moderate regime.
    const variance = (a * b) / ((a + b) * (a + b) * (a + b + 1));
    const sd = Math.sqrt(variance);
    const z = inverseNormalCdf(p);
    x = mean + z * sd;
    if (x <= 0 || x >= 1) x = mean;
  }
  // Bracket. Bisect first if the guess is off; this keeps Newton
  // from chasing wild secants.
  let lo = 0;
  let hi = 1;
  let fx = regIncBeta(x, a, b) - p;
  for (let i = 0; i < 100; i++) {
    if (Math.abs(fx) < 1e-10) return x;
    if (fx < 0) lo = x;
    else hi = x;
    // Newton step: derivative of I_x(a, b) wrt x is the Beta pdf.
    // betaPdf(x; a, b) = x^(a-1) * (1-x)^(b-1) / B(a, b).
    const logPdf = (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lbeta(a, b);
    const pdf = Math.exp(logPdf);
    let next = x - fx / pdf;
    if (next <= lo || next >= hi || !Number.isFinite(next)) {
      // Newton escaped the bracket; bisect.
      next = (lo + hi) / 2;
    }
    if (Math.abs(next - x) < 1e-12) return next;
    x = next;
    fx = regIncBeta(x, a, b) - p;
  }
  return x;
}

/**
 * Inverse standard normal CDF (quantile function). Beasley-Springer-
 * Moro approximation, accurate to ~1e-9. Used only to seed the
 * Newton iteration in betaInv; the bisection fallback corrects any
 * error this introduces.
 */
function inverseNormalCdf(p: number): number {
  // Coefficients for the central region (Beasley-Springer-Moro).
  const a1 = -3.969683028665376e1;
  const a2 = 2.209460984245205e2;
  const a3 = -2.759285104469687e2;
  const a4 = 1.38357751867269e2;
  const a5 = -3.066479806614716e1;
  const a6 = 2.506628277459239;
  const b1 = -5.447609879822406e1;
  const b2 = 1.615858368580409e2;
  const b3 = -1.556989798598866e2;
  const b4 = 6.680131188771972e1;
  const b5 = -1.328068155288572e1;
  const c1 = -7.784894002430293e-3;
  const c2 = -3.223964580411365e-1;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;
  const d1 = 7.784695709041462e-3;
  const d2 = 3.224671290700398e-1;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
  );
}

/**
 * Confidence clamp applied at ingest. Below CONFIDENCE_FLOOR the
 * observation is dropped entirely (the worker's "I'm genuinely
 * unsure" channel); above CONFIDENCE_CAP it's pulled down to the
 * cap. Exposed here rather than living inline in the agent so the
 * unit tests can pin the floor/cap semantics directly.
 */
export function clampConfidence(c: number, floor: number, cap: number): number | null {
  if (Number.isNaN(c)) return null;
  if (c < floor) return null;
  if (c > cap) return cap;
  return c;
}
