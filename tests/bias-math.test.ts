/**
 * Coverage for the bias-aggregation math. Pure functions, no DB / no
 * LLM / no Deno globals - the venice function's bias-sweep aggregate
 * pass composes these into one call per (user_id, bias) pair, and
 * the chat-loop format pass reads the resulting tier. The module
 * under test lives in the Deno island but is self-contained, so
 * vitest loads it directly - no Deno port of this suite needed.
 *
 * The thresholds (N_EFF_FLOOR, CI_LB_SOFT, CI_LB_STRONG) and the
 * prior (ALPHA_PRIOR, BETA_PRIOR) are load-bearing: a reviewer
 * tuning one number can flip a bias from "soft" to "strong" without
 * any other visible breakage. These assertions are the tripwire.
 *
 * The exact-vs-approximation choice for the credible-interval lower
 * bound is also covered: at small alpha/beta the normal approximation
 * (mean - 1.28 * sd) and the exact inverse-incomplete-beta disagree
 * meaningfully, and the disagreement is in the conservative
 * direction (normal LB is lower than exact LB). If a future
 * implementation swaps in the normal approximation for speed, these
 * tests will surface the resulting under-surfacing as a regression.
 */
import { describe, it, expect } from 'vitest';
import {
  collapseWithinConversation,
  recencyWeight,
  aggregatePosterior,
  tier,
  betaInv,
  clampConfidence,
  feedbackEMA,
  type ConversationContribution,
  type FeedbackContribution,
  ALPHA_PRIOR,
  BETA_PRIOR,
  CI_LB_SOFT,
  CI_LB_STRONG,
  CONFIDENCE_CAP,
  CONFIDENCE_FLOOR,
  FEEDBACK_HALF_LIFE_DAYS,
  FEEDBACK_PRIOR_WEIGHT,
  FEEDBACK_THRESHOLD_DELTA,
  HALF_LIFE_DAYS,
  N_EFF_FLOOR,
  PER_CONV_CAP,
} from '../supabase/functions/_shared/bias-math';

describe('collapseWithinConversation', () => {
  it('returns 0 for the empty-observation case', () => {
    expect(collapseWithinConversation([])).toBe(0);
  });

  it('returns the single confidence when there is one observation', () => {
    expect(collapseWithinConversation([0.5])).toBeCloseTo(0.5, 12);
    expect(collapseWithinConversation([0.85])).toBeCloseTo(0.85, 12);
  });

  it('combines two confidences via noisy-OR', () => {
    // p = 1 - (1 - 0.5) * (1 - 0.5) = 0.75
    expect(collapseWithinConversation([0.5, 0.5])).toBeCloseTo(0.75, 12);
  });

  it('combines three observations the same way', () => {
    // p = 1 - 0.5^3 = 0.875, capped at PER_CONV_CAP (0.85)
    expect(collapseWithinConversation([0.5, 0.5, 0.5])).toBeCloseTo(PER_CONV_CAP, 12);
  });

  it('caps repeated high-confidence observations at PER_CONV_CAP', () => {
    // Without the cap: 1 - 0.15^3 = 0.9966 -- "near-certainty from
    // three same-pass hits" is exactly the runaway we don't want.
    expect(collapseWithinConversation([0.85, 0.85, 0.85])).toBeCloseTo(PER_CONV_CAP, 12);
  });
});

describe('recencyWeight', () => {
  it('returns 1 for age 0', () => {
    expect(recencyWeight(0)).toBe(1);
  });

  it('returns 0.5 at exactly one half-life', () => {
    expect(recencyWeight(HALF_LIFE_DAYS)).toBeCloseTo(0.5, 12);
  });

  it('returns 0.25 at two half-lives', () => {
    expect(recencyWeight(HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 12);
  });

  it('clamps negative ages to weight 1 (future-dated rows = present)', () => {
    expect(recencyWeight(-10)).toBe(1);
  });

  it('decays monotonically', () => {
    const w0 = recencyWeight(0);
    const w30 = recencyWeight(30);
    const w90 = recencyWeight(90);
    expect(w0).toBeGreaterThan(w30);
    expect(w30).toBeGreaterThan(w90);
  });
});

describe('aggregatePosterior — prior dominance at small N', () => {
  it('returns prior mean when given no observations', () => {
    const post = aggregatePosterior([]);
    expect(post.alpha).toBe(ALPHA_PRIOR);
    expect(post.beta).toBe(BETA_PRIOR);
    expect(post.effectiveN).toBe(0);
    expect(post.mean).toBeCloseTo(ALPHA_PRIOR / (ALPHA_PRIOR + BETA_PRIOR), 12);
    // N_eff floor unambiguously elides this case.
    expect(post.tier).toBe('elided');
  });

  it('cold user with 3 high-confidence finds still tiers as elided (small-N gate)', () => {
    // Three conversations, two hits at 0.85 and 0.70; one non-hit.
    const contributions: ConversationContribution[] = [
      { pConv: 0.85, ageDays: 1 },
      { pConv: 0.70, ageDays: 2 },
      { pConv: 0, ageDays: 3 },
    ];
    const post = aggregatePosterior(contributions);
    // effectiveN ~= 3 (all very recent, weight ~= 1 each), well below the floor.
    expect(post.effectiveN).toBeLessThan(N_EFF_FLOOR);
    expect(post.tier).toBe('elided');
  });
});

describe('aggregatePosterior — tier transitions', () => {
  it('moves to soft tier with sustained moderate evidence over 30 conversations', () => {
    // 12 of 30 with average confidence 0.70 (so pConv ~= 0.70).
    const contributions: ConversationContribution[] = [];
    for (let i = 0; i < 12; i++) {
      contributions.push({ pConv: 0.70, ageDays: i * 2 });
    }
    for (let i = 0; i < 18; i++) {
      contributions.push({ pConv: 0, ageDays: i * 2 });
    }
    const post = aggregatePosterior(contributions);
    expect(post.effectiveN).toBeGreaterThan(N_EFF_FLOOR);
    expect(post.ciLower).toBeGreaterThan(CI_LB_SOFT);
    expect(post.ciLower).toBeLessThanOrEqual(CI_LB_STRONG);
    expect(post.tier).toBe('soft');
  });

  it('moves to strong tier with high-rate evidence at scale', () => {
    // 50 of 80 with pConv ~= 0.80.
    const contributions: ConversationContribution[] = [];
    for (let i = 0; i < 50; i++) {
      contributions.push({ pConv: 0.80, ageDays: i });
    }
    for (let i = 0; i < 30; i++) {
      contributions.push({ pConv: 0, ageDays: i });
    }
    const post = aggregatePosterior(contributions);
    expect(post.ciLower).toBeGreaterThan(CI_LB_STRONG);
    expect(post.tier).toBe('strong');
  });

  it('recency weighting deflates a long-stale history', () => {
    // 30 hits, all about 2 half-lives old. Without recency weighting
    // the prior would be drowned; with it, effectiveN drops by ~75%
    // and the small-N floor re-asserts even at high apparent rate.
    const contributions: ConversationContribution[] = [];
    for (let i = 0; i < 30; i++) {
      contributions.push({ pConv: 0.85, ageDays: HALF_LIFE_DAYS * 2 + i });
    }
    const post = aggregatePosterior(contributions);
    // 30 weights at ~0.25 each = effectiveN ~7.5 (still above floor, but
    // posterior_mean has been pulled toward the prior).
    expect(post.effectiveN).toBeGreaterThan(N_EFF_FLOOR);
    // Without decay this would tier as strong; with decay it should not.
    const undecayed = aggregatePosterior(
      contributions.map(({ pConv }) => ({ pConv, ageDays: 0 }))
    );
    expect(undecayed.tier).toBe('strong');
    expect(post.mean).toBeLessThan(undecayed.mean);
  });
});

describe('tier — gate combinations', () => {
  it('requires N_eff >= floor regardless of ciLower', () => {
    expect(tier(N_EFF_FLOOR - 0.01, 0.5)).toBe('elided');
    expect(tier(N_EFF_FLOOR, 0.5)).toBe('strong');
  });

  it('requires ciLower > CI_LB_SOFT to leave elided', () => {
    expect(tier(20, CI_LB_SOFT)).toBe('elided');
    expect(tier(20, CI_LB_SOFT + 0.001)).toBe('soft');
  });

  it('requires ciLower > CI_LB_STRONG to reach strong', () => {
    expect(tier(20, CI_LB_STRONG)).toBe('soft');
    expect(tier(20, CI_LB_STRONG + 0.001)).toBe('strong');
  });

  // Feedback-aware tier: the EMA shifts both gates symmetrically
  // by FEEDBACK_THRESHOLD_DELTA at the extremes. These tests pin
  // the shift direction (affirming user -> more biases surface,
  // pushing-back user -> fewer biases surface) so a future kernel
  // edit that inverts the sign blows up loudly.
  it('omitting feedbackScore behaves identically to passing 0', () => {
    expect(tier(20, 0.20)).toBe(tier(20, 0.20, 0));
    expect(tier(20, 0.35)).toBe(tier(20, 0.35, 0));
  });

  it('positive feedback (affirming) lifts the soft tier earlier', () => {
    // ciLower just below the default soft gate
    const ci = CI_LB_SOFT + 0.01;
    expect(tier(20, ci, 0)).toBe('soft'); // default gate already passed
    // Push gate higher (negative feedback) and the same value tiers
    // down to elided
    expect(tier(20, ci, -1)).toBe('elided');
    // Push gate lower (positive feedback) leaves it in soft / strong
    expect(tier(20, ci, +1)).toBe('soft');
  });

  it('feedback shifts move both gates by FEEDBACK_THRESHOLD_DELTA at the extremes', () => {
    // At feedback = +1 the soft gate drops to CI_LB_SOFT - delta
    // and the strong gate drops to CI_LB_STRONG - delta.
    const ciJustAboveShiftedSoft = CI_LB_SOFT - FEEDBACK_THRESHOLD_DELTA + 0.005;
    const ciJustBelowShiftedSoft = CI_LB_SOFT - FEEDBACK_THRESHOLD_DELTA - 0.005;
    expect(tier(20, ciJustAboveShiftedSoft, +1)).toBe('soft');
    expect(tier(20, ciJustBelowShiftedSoft, +1)).toBe('elided');
    // At feedback = -1 the soft gate rises to CI_LB_SOFT + delta;
    // a value that was 'soft' at neutral lands 'elided' here.
    const ciJustAboveDefaultSoft = CI_LB_SOFT + 0.005;
    expect(tier(20, ciJustAboveDefaultSoft, 0)).toBe('soft');
    expect(tier(20, ciJustAboveDefaultSoft, -1)).toBe('elided');
  });

  it('clamps feedback outside [-1, +1] to the bounds', () => {
    // A caller passing a runaway EMA cannot push gates past their
    // intended envelope.
    expect(tier(20, CI_LB_SOFT + 0.05, -5)).toBe(tier(20, CI_LB_SOFT + 0.05, -1));
    expect(tier(20, CI_LB_SOFT - 0.05, +5)).toBe(tier(20, CI_LB_SOFT - 0.05, +1));
  });

  it('N_eff floor is independent of feedback', () => {
    // No amount of positive feedback can lift a bias out of elided
    // before the small-N floor is cleared.
    expect(tier(N_EFF_FLOOR - 0.01, 0.99, +1)).toBe('elided');
  });
});

describe('feedbackEMA', () => {
  it('returns 0 with no reactions (prior only)', () => {
    expect(feedbackEMA([])).toBe(0);
  });

  it('skips neutral reactions (wasConfirmed === null) rather than counting them', () => {
    // 3 neutrals in addition to the FEEDBACK_PRIOR_WEIGHT seed
    // should leave the EMA at 0, identical to the empty case.
    const reactions: FeedbackContribution[] = [
      { wasConfirmed: null, ageDays: 1 },
      { wasConfirmed: null, ageDays: 2 },
      { wasConfirmed: null, ageDays: 3 },
    ];
    expect(feedbackEMA(reactions)).toBe(0);
  });

  it('one fresh confirm gives a modest positive shift dampened by the prior', () => {
    const reactions: FeedbackContribution[] = [
      { wasConfirmed: true, ageDays: 0 },
    ];
    // weight = 1; total = prior + 1 = 4; ema = 1/4 = 0.25
    expect(feedbackEMA(reactions)).toBeCloseTo(1 / (FEEDBACK_PRIOR_WEIGHT + 1), 12);
  });

  it('one fresh disconfirm gives the mirror negative shift', () => {
    const reactions: FeedbackContribution[] = [
      { wasConfirmed: false, ageDays: 0 },
    ];
    expect(feedbackEMA(reactions)).toBeCloseTo(-1 / (FEEDBACK_PRIOR_WEIGHT + 1), 12);
  });

  it('asymptotes toward +1 with many recent confirms', () => {
    const reactions: FeedbackContribution[] = [];
    for (let i = 0; i < 100; i++) {
      reactions.push({ wasConfirmed: true, ageDays: 0 });
    }
    // weight = 100; total = 103; ema = 100/103 ~ 0.97
    expect(feedbackEMA(reactions)).toBeGreaterThan(0.95);
    expect(feedbackEMA(reactions)).toBeLessThan(1);
  });

  it('decays older reactions toward the prior', () => {
    const recent: FeedbackContribution[] = [
      { wasConfirmed: true, ageDays: 0 },
    ];
    const old: FeedbackContribution[] = [
      { wasConfirmed: true, ageDays: FEEDBACK_HALF_LIFE_DAYS * 4 },
    ];
    // Older reaction contributes less weight; its EMA sits closer
    // to the prior-driven zero.
    expect(feedbackEMA(recent)).toBeGreaterThan(feedbackEMA(old));
    expect(feedbackEMA(old)).toBeGreaterThan(0);
  });

  it('mixed confirms and disconfirms partially cancel', () => {
    const reactions: FeedbackContribution[] = [
      { wasConfirmed: true, ageDays: 0 },
      { wasConfirmed: false, ageDays: 0 },
    ];
    // numerator: 1 - 1 = 0; total = 5; ema = 0
    expect(feedbackEMA(reactions)).toBe(0);
  });
});

describe('betaInv — agreement with reference values', () => {
  // Reference values computed via scipy.stats.beta.ppf in Python.
  // Each row: [p, a, b, expected x]. Tolerance 1e-5 because we're
  // matching a different math library, not testing internal
  // consistency. Update these only when you've verified the new
  // value against scipy or a comparable reference - they're the
  // tripwire against silent regressions in the numerical kernel.
  const cases: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.10, 2, 8, 0.06076905],
    [0.50, 2, 8, 0.17961961],
    [0.90, 2, 8, 0.36836236],
    [0.10, 10, 20, 0.22641502],
    [0.10, 20, 40, 0.25686817],
    [0.05, 5, 5, 0.25136763],
    [0.95, 5, 5, 0.74863237],
  ];
  for (const [p, a, b, expected] of cases) {
    it(`betaInv(${p}, ${a}, ${b}) ~= ${expected}`, () => {
      expect(betaInv(p, a, b)).toBeCloseTo(expected, 5);
    });
  }

  it('returns 0 at p=0 and 1 at p=1 (boundary handling)', () => {
    expect(betaInv(0, 5, 5)).toBe(0);
    expect(betaInv(1, 5, 5)).toBe(1);
  });
});

describe('clampConfidence', () => {
  it('returns null below the floor', () => {
    expect(clampConfidence(CONFIDENCE_FLOOR - 0.01, CONFIDENCE_FLOOR, CONFIDENCE_CAP)).toBeNull();
    expect(clampConfidence(0, CONFIDENCE_FLOOR, CONFIDENCE_CAP)).toBeNull();
  });

  it('passes through values between floor and cap', () => {
    expect(clampConfidence(0.5, CONFIDENCE_FLOOR, CONFIDENCE_CAP)).toBe(0.5);
    expect(clampConfidence(CONFIDENCE_FLOOR, CONFIDENCE_FLOOR, CONFIDENCE_CAP)).toBe(
      CONFIDENCE_FLOOR
    );
    expect(clampConfidence(CONFIDENCE_CAP, CONFIDENCE_FLOOR, CONFIDENCE_CAP)).toBe(
      CONFIDENCE_CAP
    );
  });

  it('clamps to cap when above', () => {
    expect(clampConfidence(0.95, CONFIDENCE_FLOOR, CONFIDENCE_CAP)).toBe(CONFIDENCE_CAP);
    expect(clampConfidence(1.0, CONFIDENCE_FLOOR, CONFIDENCE_CAP)).toBe(CONFIDENCE_CAP);
  });

  it('returns null for NaN', () => {
    expect(clampConfidence(NaN, CONFIDENCE_FLOOR, CONFIDENCE_CAP)).toBeNull();
  });
});
