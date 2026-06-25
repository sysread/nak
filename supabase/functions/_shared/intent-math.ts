// Pure math for the intents feature's honest efficacy loop. This is
// the load-bearing integrity core: an intent is a normative goal the
// chat model forms about how it wants to help the user grow, and the
// one rule that keeps the loop from becoming a confirmation engine is
// that an intent's "is this working?" signal is read from the
// descriptive layer (bias posteriors, samskara fire frequency) and
// NEVER from the model's own self-assessment. This module owns the
// arithmetic of that read. See docs/dev/in-progress/intents.md (the C
// efficacy model + Evaluation sections) for the design rationale.
//
// Self-contained (no relative imports) so the Deno island, vitest
// (tests/intent-math.test.ts), and tsc can all load it - same
// constraint bias-math.ts and samskara-format.ts carry. The eventual
// production consumer is the intent evaluation sweep (not yet built);
// the vitest suite is the current consumer and pins every behavior
// below.
//
// Two distinct signals live here, and conflating them is the failure
// mode the whole design exists to prevent:
//
//   - EFFICACY (this module): did the descriptive-layer metric the
//     intent targets actually move the right way, MORE than a matched
//     control moved? Governs whether an intent strengthens or retires.
//   - EMPLOYMENT (not this module - intent_employments rows): did the
//     model act on the intent, and how did the user react? Neutral
//     process telemetry. It must never feed efficacy. The
//     `pearson` helper here exists precisely to let the backtest
//     PROVE the two stay uncorrelated.

/** A single sample's verdict against the intent's target. */
export type IntentVerdict = 'confirm' | 'disconfirm' | 'soft-miss';

/** Which way "better" runs for an intent's descriptive-layer target. */
export type TargetDirection = 'reduce' | 'reinforce';

// --- Tuning constants ------------------------------------------------------
//
// These mirror the samskara health posterior (see docs/dev/samskara.md
// "Health: the verdict posterior") because the shape of the problem is
// identical: a recency-discounted hit rate that regresses toward a
// population baseline when evidence goes stale. The values below are
// LAUNCH PLACEHOLDERS - the design doc commits to deriving them from
// the offline backtest against the live corpus, not eyeballing them
// now. They are pinned here only so the mechanics are testable; expect
// the backtest milestone to retune them.

// L: half-life in evaluation cycles for the evidence discount. After L
// evaluations with no fresh confirming movement, prior evidence has
// half its weight. Placeholder; the backtest sets this from the
// observed evaluation cadence the way samskara derives its L.
export const EFFICACY_HALF_LIFE_EVALS = 6;

// w_soft: a soft miss (target did not move meaningfully relative to
// control) is real but weak evidence against the intent working - a
// fractional disconfirm, not a full one. Carried over from samskara's
// not-borne-out weight with the same rationale; the backtest may raise
// it if efficacy under-discriminates.
export const EFFICACY_SOFT_MISS_WEIGHT = 0.25;

// k: prior strength (pseudo-count). An evidence-less intent sits at the
// population baseline p0 with this much weight before its own samples
// move it - the shrinkage-toward-population prior.
export const EFFICACY_PRIOR_STRENGTH = 5;

// Weak-neutral fallback for the population baseline when the corpus has
// too little settled evidence to estimate its own aggregate hit rate.
// 0.5 = "no reason to assume an intent works or fails until tested",
// matching samskara_population_p0's neutral fallback.
export const EFFICACY_DEFAULT_P0 = 0.5;

// Default deadband for classifying a target-vs-control differential as
// "flat" (a soft miss) rather than a confirm/disconfirm. Expressed in
// the target metric's NATIVE units, so the caller SHOULD override it
// per target kind - a bias posterior lives in [0, 1] while a samskara
// fire frequency is a rate on a different scale. A single absolute
// constant cannot be right for both; this default is a conservative
// placeholder for the [0, 1] posterior case and the backtest sets the
// real per-kind bands. See classifySample.
export const DEFAULT_MOVEMENT_DEADBAND = 0.02;

/**
 * Running evidence tallies for one intent's efficacy posterior. Both
 * stay real-valued, not integer: the recency discount multiplies them
 * by a fraction every cycle, and an integer column truncating the
 * sub-unit result to 0 is the exact bug that once froze the whole
 * samskara corpus at health 0 (see docs/dev/samskara.md). The DB
 * columns these map to must be `real` for the same reason.
 */
export interface EfficacyEvidence {
  confirmCount: number;
  disconfirmCount: number;
}

/**
 * Classify one evaluation-cycle sample into a verdict.
 *
 * The honest-loop heart: the verdict is the DIFFERENTIAL between how
 * much the target moved in the desired direction and how much a matched
 * control cohort moved over the same window - NOT the target's absolute
 * movement. This is the regression-to-the-mean defense built into the
 * per-intent signal itself, not bolted on at the aggregate. An intent
 * minted on a spike that then reverts on its own gains NO credit,
 * because its matched control reverted just as far: the differential is
 * ~0, which classifies as a soft miss, not a confirm. Absolute movement
 * would hand that intent a false win - the single trap the design names
 * as fatal.
 *
 * `prev`/`curr` are the targeted metric at the start and end of the
 * window; `prevControl`/`currControl` are the matched-cohort average
 * over the same window. For `direction: 'reduce'` the desired move is
 * downward; for `'reinforce'`, upward.
 *
 * When no control is available (`controlPrev`/`controlCurr` null - no
 * comparable cohort exists yet), the classifier falls back to absolute
 * target movement. This is deliberately weaker and the caller is
 * expected to track control coverage as a backtest health metric: a
 * corpus where most samples lack a control cannot defend against
 * regression to the mean, and that fact must be visible, not hidden.
 *
 * `deadband` is in the metric's native units; pass a per-target-kind
 * value (see DEFAULT_MOVEMENT_DEADBAND).
 */
export function classifySample(args: {
  direction: TargetDirection;
  prev: number;
  curr: number;
  controlPrev?: number | null;
  controlCurr?: number | null;
  deadband?: number;
}): IntentVerdict {
  const { direction, prev, curr } = args;
  const deadband = args.deadband ?? DEFAULT_MOVEMENT_DEADBAND;

  // Orient so a positive number always means "moved the way the intent
  // wants". reduce -> improvement is a decrease, so flip the sign.
  const desired = direction === 'reduce' ? -1 : 1;
  const targetMove = desired * (curr - prev);

  const hasControl =
    args.controlPrev != null &&
    args.controlCurr != null &&
    Number.isFinite(args.controlPrev) &&
    Number.isFinite(args.controlCurr);

  // Differential when a control exists; absolute target movement when it
  // does not. The differential is what makes a self-reverting spike a
  // non-event.
  const signal = hasControl
    ? targetMove - desired * ((args.controlCurr as number) - (args.controlPrev as number))
    : targetMove;

  if (signal > deadband) return 'confirm';
  if (signal < -deadband) return 'disconfirm';
  return 'soft-miss';
}

/**
 * Fold one verdict into an intent's running evidence with the recency
 * discount, then recompute the efficacy posterior. One online step,
 * mirroring samskara_apply_evaluation:
 *
 *   1. Discount BOTH prior tallies by d = 0.5^(1/L) - the forgetting.
 *      A cycle that earns no fresh confirm lets prior evidence decay,
 *      so the posterior regresses toward the population baseline. This
 *      is relevance-gated forgetting: a target whose metric is sampled
 *      but does not move loses standing; a free-form intent that is
 *      never sampled is never discounted here at all.
 *   2. Fold the verdict: confirm -> +1 confirm; disconfirm -> +1
 *      disconfirm; soft-miss -> +w_soft disconfirm (fractional).
 *   3. Recompute the shrinkage posterior toward p0.
 *
 * Returns the new evidence tallies and the new efficacy in [0, 1]. The
 * posterior is a weighted average of {0, 1} outcomes with p0, so it is
 * inherently bounded to [0, 1] and cannot run away.
 *
 * `p0` is the population's aggregate hit rate across the user's intents
 * (caller computes it; pass EFFICACY_DEFAULT_P0 under weak evidence).
 * `k` and `L` default to the module constants.
 */
export function updateEfficacy(
  prior: EfficacyEvidence,
  verdict: IntentVerdict,
  opts: {
    p0?: number;
    priorStrength?: number;
    halfLifeEvals?: number;
    softMissWeight?: number;
  } = {}
): { evidence: EfficacyEvidence; efficacy: number } {
  const p0 = opts.p0 ?? EFFICACY_DEFAULT_P0;
  const k = opts.priorStrength ?? EFFICACY_PRIOR_STRENGTH;
  const L = opts.halfLifeEvals ?? EFFICACY_HALF_LIFE_EVALS;
  const wSoft = opts.softMissWeight ?? EFFICACY_SOFT_MISS_WEIGHT;

  const d = Math.pow(0.5, 1 / L);
  let confirmCount = prior.confirmCount * d;
  let disconfirmCount = prior.disconfirmCount * d;

  if (verdict === 'confirm') confirmCount += 1;
  else if (verdict === 'disconfirm') disconfirmCount += 1;
  else disconfirmCount += wSoft; // soft-miss

  const efficacy = (confirmCount + k * p0) / (confirmCount + disconfirmCount + k);
  return { evidence: { confirmCount, disconfirmCount }, efficacy };
}

/**
 * Population baseline p0: the aggregate hit rate across the user's
 * settled intent evidence, `sum(confirm) / sum(confirm + disconfirm)`.
 * Falls back to EFFICACY_DEFAULT_P0 (neutral) under a weak-evidence
 * floor so a cold or near-cold corpus does not let one lucky intent
 * define the baseline. Mirrors samskara_population_p0.
 */
export function populationP0(
  all: readonly EfficacyEvidence[],
  minEvidence = 5
): number {
  let confirm = 0;
  let total = 0;
  for (const e of all) {
    confirm += e.confirmCount;
    total += e.confirmCount + e.disconfirmCount;
  }
  if (total < minEvidence) return EFFICACY_DEFAULT_P0;
  return confirm / total;
}

/**
 * One efficacy evaluation step for a targeted intent, composing
 * classifySample + updateEfficacy with the baseline/first-sample
 * handling. The evaluation sweep gathers the current target + control
 * metric and the most recent prior sample, and calls this.
 *
 * The FIRST sample for an intent has no prior to diff against, so it
 * establishes a baseline only: no verdict, efficacy stays null (the
 * intent is targeted but not yet scored). Every subsequent sample diffs
 * against the prior one - the per-cycle differential - and folds the
 * verdict into the posterior.
 *
 * `prev` is the prior sample's (target, control); null on the first
 * sample. `evidence` is the intent's running tally (zero on first
 * verdict). Returns the verdict (null on baseline), the new efficacy
 * (null on baseline - leave the row's efficacy untouched), and the new
 * evidence to persist.
 */
export function stepEfficacy(args: {
  direction: TargetDirection;
  prev: { target: number; control: number | null } | null;
  curr: { target: number; control: number | null };
  evidence: EfficacyEvidence;
  p0?: number;
  deadband?: number;
}): { verdict: IntentVerdict | null; efficacy: number | null; evidence: EfficacyEvidence } {
  if (!args.prev) {
    // Baseline sample: record it (the caller inserts the row) but do
    // not score - there is nothing to diff against yet.
    return { verdict: null, efficacy: null, evidence: args.evidence };
  }
  const verdict = classifySample({
    direction: args.direction,
    prev: args.prev.target,
    curr: args.curr.target,
    controlPrev: args.prev.control,
    controlCurr: args.curr.control,
    deadband: args.deadband,
  });
  const { evidence, efficacy } = updateEfficacy(args.evidence, verdict, { p0: args.p0 });
  return { verdict, efficacy, evidence };
}

// --- Backtest metrics ------------------------------------------------------
//
// These are the pure kernels behind the Evaluation plan's two
// load-bearing checks. They take already-gathered series and return a
// verdict; the harness that gathers the series from the corpus is a
// separate, later piece.

/**
 * Pearson correlation coefficient between two equal-length series.
 * Returns 0 for degenerate input (length < 2 or a zero-variance
 * series) - "no detectable linear relationship", the safe reading for
 * the firewall check.
 *
 * The firewall: the backtest computes pearson(efficacy, employmentCount)
 * across intents and asserts it stays near zero. A non-trivial positive
 * correlation means an intent the model "worked hard on" gained efficacy
 * regardless of whether its target moved - i.e. the descriptive/normative
 * separation leaked and the loop is grading its own homework. This single
 * number is how we know the firewall holds.
 */
export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/**
 * One intent's window of paired target/control movement, already
 * oriented so positive = moved the desired way. The backtest builds
 * these from intent_target_samples.
 */
export interface MovementWindow {
  targetMove: number;
  controlMove: number;
}

/**
 * The matched-control bar - the single metric that separates a real
 * effect from regression to the mean. Returns the mean target movement,
 * the mean control movement, and their difference (the "lift" the
 * intents earned over doing nothing). The committed falsifiable bar:
 * if `lift` is not meaningfully positive across the corpus within N
 * evaluation cycles, the feature stays off by default and is labeled
 * experimental.
 *
 * Returns null lift for empty input - "no evidence either way", never a
 * spurious zero that reads as "proven no effect".
 */
export function matchedControlLift(windows: readonly MovementWindow[]): {
  meanTarget: number;
  meanControl: number;
  lift: number | null;
  n: number;
} {
  const n = windows.length;
  if (n === 0) return { meanTarget: 0, meanControl: 0, lift: null, n: 0 };
  let t = 0;
  let c = 0;
  for (const w of windows) {
    t += w.targetMove;
    c += w.controlMove;
  }
  const meanTarget = t / n;
  const meanControl = c / n;
  return { meanTarget, meanControl, lift: meanTarget - meanControl, n };
}
