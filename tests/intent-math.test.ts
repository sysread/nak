/**
 * Coverage for the intents efficacy-loop math. Pure functions, no DB /
 * no LLM / no Deno globals - the (not-yet-built) intent evaluation
 * sweep will compose these, and this suite is the module's current
 * consumer. The module under test lives in the Deno island but is
 * self-contained, so vitest loads it directly.
 *
 * These assertions pin the two properties the whole feature's
 * integrity rests on, the ones a future edit could silently break
 * without any crash:
 *
 *   1. The honest loop: efficacy is driven by descriptive-layer
 *      movement RELATIVE TO A CONTROL, so a self-reverting spike earns
 *      no credit (the regression-to-the-mean defense), and the
 *      efficacy/employment firewall is computable (pearson stays near
 *      zero when they are independent).
 *   2. The posterior is bounded, regresses toward p0 when evidence
 *      goes stale, and treats a soft miss as a fractional disconfirm.
 *
 * Constants are launch placeholders (the backtest derives the real
 * values); these tests assert MECHANICS, not specific tuned outputs.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySample,
  updateEfficacy,
  populationP0,
  pearson,
  matchedControlLift,
  stepEfficacy,
  EFFICACY_DEFAULT_P0,
  EFFICACY_SOFT_MISS_WEIGHT,
  type EfficacyEvidence,
  type MovementWindow,
} from '../supabase/functions/_shared/intent-math';

describe('classifySample - the regression-to-the-mean defense', () => {
  it('confirms when the target beats its control in the desired direction', () => {
    // reduce-intent: target dropped 0.20, control dropped only 0.02.
    // Differential 0.18 >> deadband -> the intent earned real lift.
    const v = classifySample({
      direction: 'reduce',
      prev: 0.5,
      curr: 0.3,
      controlPrev: 0.5,
      controlCurr: 0.48,
    });
    expect(v).toBe('confirm');
  });

  it('does NOT confirm a self-reverting spike (target and control fall together)', () => {
    // The fatal trap: a bias spiked, an intent formed, and the bias
    // reverted on its own. Absolute movement would call this a win.
    // The matched control reverted just as far, so the differential is
    // ~0 -> soft miss, not confirm. This single assertion is why the
    // loop is honest.
    const v = classifySample({
      direction: 'reduce',
      prev: 0.6,
      curr: 0.4, // big absolute "improvement"
      controlPrev: 0.6,
      controlCurr: 0.4, // ...that the control matched exactly
    });
    expect(v).toBe('soft-miss');
  });

  it('disconfirms when the target moves the wrong way relative to control', () => {
    const v = classifySample({
      direction: 'reduce',
      prev: 0.3,
      curr: 0.5, // rose
      controlPrev: 0.3,
      controlCurr: 0.3, // control flat
    });
    expect(v).toBe('disconfirm');
  });

  it('handles reinforce-direction targets symmetrically', () => {
    // reinforce-intent: desired move is upward.
    const up = classifySample({
      direction: 'reinforce',
      prev: 0.2,
      curr: 0.5,
      controlPrev: 0.2,
      controlCurr: 0.22,
    });
    expect(up).toBe('confirm');
    const down = classifySample({
      direction: 'reinforce',
      prev: 0.5,
      curr: 0.2,
      controlPrev: 0.5,
      controlCurr: 0.5,
    });
    expect(down).toBe('disconfirm');
  });

  it('falls back to absolute movement when no control is supplied', () => {
    // Free-of-control samples are weaker but not discarded; the caller
    // tracks control coverage separately.
    const v = classifySample({
      direction: 'reduce',
      prev: 0.5,
      curr: 0.3,
      controlPrev: null,
      controlCurr: null,
    });
    expect(v).toBe('confirm');
  });

  it('treats movement inside the deadband as a soft miss', () => {
    const v = classifySample({
      direction: 'reduce',
      prev: 0.5,
      curr: 0.495, // 0.005 < default deadband 0.02
      controlPrev: null,
      controlCurr: null,
    });
    expect(v).toBe('soft-miss');
  });
});

describe('updateEfficacy - bounded, regressing posterior', () => {
  const zero: EfficacyEvidence = { confirmCount: 0, disconfirmCount: 0 };

  it('a fresh intent with no evidence sits at p0', () => {
    // Before any sample, efficacy should be exactly the population
    // baseline - the shrinkage prior with zero data.
    const { efficacy } = updateEfficacy(zero, 'soft-miss', {
      p0: 0.5,
      softMissWeight: 0, // isolate the prior by neutralizing the verdict
    });
    expect(efficacy).toBeCloseTo(0.5, 6);
  });

  it('stays within [0, 1] under a long confirm streak', () => {
    let ev = zero;
    let efficacy = 0;
    for (let i = 0; i < 100; i++) {
      const out = updateEfficacy(ev, 'confirm', { p0: 0.5 });
      ev = out.evidence;
      efficacy = out.efficacy;
      expect(efficacy).toBeGreaterThanOrEqual(0);
      expect(efficacy).toBeLessThanOrEqual(1);
    }
    // Many confirms drive it high but never to 1 (the prior holds it back).
    expect(efficacy).toBeGreaterThan(0.8);
    expect(efficacy).toBeLessThan(1);
  });

  it('confirms raise efficacy and disconfirms lower it', () => {
    const up = updateEfficacy(zero, 'confirm', { p0: 0.5 }).efficacy;
    const down = updateEfficacy(zero, 'disconfirm', { p0: 0.5 }).efficacy;
    expect(up).toBeGreaterThan(0.5);
    expect(down).toBeLessThan(0.5);
  });

  it('a soft miss is a fractional disconfirm, weaker than a full one', () => {
    const softMiss = updateEfficacy(zero, 'soft-miss', { p0: 0.5 }).efficacy;
    const disconfirm = updateEfficacy(zero, 'disconfirm', { p0: 0.5 }).efficacy;
    // soft miss adds w_soft (< 1) to disconfirm, so it lands between
    // neutral and a full disconfirm.
    expect(softMiss).toBeLessThan(0.5);
    expect(softMiss).toBeGreaterThan(disconfirm);
    expect(EFFICACY_SOFT_MISS_WEIGHT).toBeGreaterThan(0);
    expect(EFFICACY_SOFT_MISS_WEIGHT).toBeLessThan(1);
  });

  it('regresses a confirmed intent back toward p0 across stale soft-miss cycles', () => {
    // Build standing on confirms...
    let ev = zero;
    for (let i = 0; i < 5; i++) ev = updateEfficacy(ev, 'confirm', { p0: 0.4 }).evidence;
    const peak = updateEfficacy(ev, 'confirm', { p0: 0.4 }).efficacy;
    // ...then let the target go quiet (soft misses discount the prior).
    let cur = ev;
    let efficacy = peak;
    for (let i = 0; i < 20; i++) {
      const out = updateEfficacy(cur, 'soft-miss', { p0: 0.4 });
      cur = out.evidence;
      efficacy = out.efficacy;
    }
    // It decays back toward the population baseline, not below the floor.
    expect(efficacy).toBeLessThan(peak);
    expect(efficacy).toBeGreaterThanOrEqual(0);
  });
});

describe('populationP0', () => {
  it('returns the neutral fallback under the weak-evidence floor', () => {
    expect(populationP0([], 5)).toBe(EFFICACY_DEFAULT_P0);
    expect(populationP0([{ confirmCount: 1, disconfirmCount: 1 }], 5)).toBe(
      EFFICACY_DEFAULT_P0
    );
  });

  it('computes the aggregate hit rate once evidence clears the floor', () => {
    const corpus: EfficacyEvidence[] = [
      { confirmCount: 6, disconfirmCount: 2 },
      { confirmCount: 2, disconfirmCount: 0 },
    ];
    // 8 confirms / 10 total = 0.8
    expect(populationP0(corpus, 5)).toBeCloseTo(0.8, 6);
  });
});

describe('pearson - the efficacy/employment firewall check', () => {
  it('is near zero when efficacy and employment are independent', () => {
    // Employment climbs steadily; efficacy is unrelated noise. A healthy
    // firewall reads ~0 - the model working hard on an intent does NOT
    // move its efficacy.
    const employment = [1, 2, 3, 4, 5, 6, 7, 8];
    const efficacy = [0.5, 0.3, 0.6, 0.4, 0.5, 0.35, 0.55, 0.45];
    expect(Math.abs(pearson(employment, efficacy))).toBeLessThan(0.4);
  });

  it('detects a leak: efficacy tracking employment reads strongly positive', () => {
    // The failure mode: efficacy rises with how much the model used the
    // intent. The backtest must be able to SEE this if it ever happens.
    const employment = [1, 2, 3, 4, 5, 6, 7, 8];
    const efficacy = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    expect(pearson(employment, efficacy)).toBeGreaterThan(0.95);
  });

  it('returns 0 for degenerate input rather than NaN', () => {
    expect(pearson([], [])).toBe(0);
    expect(pearson([1], [1])).toBe(0);
    expect(pearson([2, 2, 2], [1, 2, 3])).toBe(0); // zero variance in xs
  });
});

describe('stepEfficacy - the per-cycle evaluation step', () => {
  const zero: EfficacyEvidence = { confirmCount: 0, disconfirmCount: 0 };

  it('establishes a baseline on the first sample: no verdict, efficacy stays null', () => {
    const out = stepEfficacy({
      direction: 'reduce',
      prev: null,
      curr: { target: 0.5, control: 0.5 },
      evidence: zero,
    });
    expect(out.verdict).toBeNull();
    expect(out.efficacy).toBeNull();
    expect(out.evidence).toEqual(zero);
  });

  it('scores a real improvement over control as a confirm and lifts efficacy', () => {
    const out = stepEfficacy({
      direction: 'reduce',
      prev: { target: 0.5, control: 0.5 },
      curr: { target: 0.3, control: 0.48 }, // target fell far more than control
      evidence: zero,
      p0: 0.5,
    });
    expect(out.verdict).toBe('confirm');
    expect(out.efficacy!).toBeGreaterThan(0.5);
  });

  it('scores a self-reverting spike (target and control fall together) as a soft miss', () => {
    const out = stepEfficacy({
      direction: 'reduce',
      prev: { target: 0.6, control: 0.6 },
      curr: { target: 0.4, control: 0.4 },
      evidence: zero,
      p0: 0.5,
    });
    expect(out.verdict).toBe('soft-miss');
    expect(out.efficacy!).toBeLessThan(0.5);
  });

  it('handles a null control by falling back to absolute movement', () => {
    const out = stepEfficacy({
      direction: 'reduce',
      prev: { target: 0.5, control: null },
      curr: { target: 0.3, control: null },
      evidence: zero,
      p0: 0.5,
    });
    expect(out.verdict).toBe('confirm');
  });
});

describe('matchedControlLift - the committed falsifiable bar', () => {
  it('reports the lift of targeted patterns over their controls', () => {
    const windows: MovementWindow[] = [
      { targetMove: 0.2, controlMove: 0.05 },
      { targetMove: 0.1, controlMove: 0.0 },
      { targetMove: 0.15, controlMove: 0.05 },
    ];
    const r = matchedControlLift(windows);
    expect(r.n).toBe(3);
    expect(r.meanTarget).toBeCloseTo(0.15, 6);
    expect(r.meanControl).toBeCloseTo(0.0333, 3);
    expect(r.lift as number).toBeGreaterThan(0); // beats control -> real effect
  });

  it('reports ~zero lift when targets only move as much as controls', () => {
    const windows: MovementWindow[] = [
      { targetMove: 0.1, controlMove: 0.1 },
      { targetMove: 0.2, controlMove: 0.2 },
    ];
    expect(matchedControlLift(windows).lift as number).toBeCloseTo(0, 6);
  });

  it('returns null lift for empty input, not a spurious zero', () => {
    // "no evidence either way" must be distinguishable from "proven no
    // effect" - the toggle stays experimental on null, not on a false 0.
    expect(matchedControlLift([]).lift).toBeNull();
  });
});
