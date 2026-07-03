/**
 * Unit coverage for the bias-profile modal's UI primitives. Pure
 * functions - no runes, no DOM, no reactive state - tested via
 * plain vitest.
 *
 * The companion `src/screens/BiasProfile.svelte` is the only
 * caller that wires these into Svelte reactivity; a port to
 * another framework would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import { BIAS_CATALOG } from '../src/lib/bias/catalog';
import { CI_LB_STRONG, RENDER_CAP } from '../src/lib/bias/types';
import {
  type BiasSummaryDisplayRow,
  barWidthPct,
  biasDefinition,
  biasGuidance,
  biasHue,
  biasLabel,
  chartScale,
  currentObservationsEmptyCopy,
  currentReactionsEmptyCopy,
  displayThreadTitle,
  formatConfidence,
  formatEffectiveN,
  formatFeedback,
  formatProbability,
  formatTimestamp,
  hasEvidence,
  interpretBias,
  observationsLabel,
  reactionVerdict,
  reactionVerdictClass,
  reactionVerdictTitle,
  renderedBiasRows,
  sortSummaryRows,
  tierTitle,
} from '../src/lib/ui/bias-profile';

function makeRow(
  bias: string,
  overrides: Partial<BiasSummaryDisplayRow> = {},
): BiasSummaryDisplayRow {
  return {
    bias,
    effectiveN: 10,
    posteriorMean: 0.2,
    ciLower: 0.1,
    feedbackScore: 0,
    tier: 'elided',
    ...overrides,
  };
}

describe('sortSummaryRows', () => {
  it('orders strong before soft before elided, ciLower descending within a tier', () => {
    const rows = [
      makeRow('a', { tier: 'elided', ciLower: 0.05 }),
      makeRow('b', { tier: 'soft', ciLower: 0.16 }),
      makeRow('c', { tier: 'strong', ciLower: 0.31 }),
      makeRow('d', { tier: 'soft', ciLower: 0.2 }),
    ];
    expect(sortSummaryRows(rows).map((r) => r.bias)).toEqual([
      'c',
      'd',
      'b',
      'a',
    ]);
  });

  it('does not mutate the input array', () => {
    const rows = [
      makeRow('a', { tier: 'elided' }),
      makeRow('b', { tier: 'strong' }),
    ];
    sortSummaryRows(rows);
    expect(rows.map((r) => r.bias)).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty input', () => {
    expect(sortSummaryRows([])).toEqual([]);
  });
});

describe('renderedBiasRows', () => {
  it('drops elided rows entirely', () => {
    const rows = [
      makeRow('a', { tier: 'elided', ciLower: 0.9 }),
      makeRow('b', { tier: 'soft', ciLower: 0.16 }),
    ];
    expect(renderedBiasRows(rows).map((r) => r.bias)).toEqual(['b']);
  });

  it('caps the rendered set at RENDER_CAP, top by ciLower', () => {
    const rows = Array.from({ length: RENDER_CAP + 2 }, (_, i) =>
      makeRow(`b${i}`, { tier: 'soft', ciLower: 0.16 + i * 0.01 }),
    );
    const out = renderedBiasRows(rows);
    expect(out).toHaveLength(RENDER_CAP);
    // Highest ciLower first; the two weakest rows fell off.
    expect(out[0].bias).toBe(`b${RENDER_CAP + 1}`);
    expect(out.map((r) => r.bias)).not.toContain('b0');
  });

  it('does not mutate the input array', () => {
    const rows = [
      makeRow('a', { tier: 'soft', ciLower: 0.16 }),
      makeRow('b', { tier: 'strong', ciLower: 0.31 }),
    ];
    renderedBiasRows(rows);
    expect(rows.map((r) => r.bias)).toEqual(['a', 'b']);
  });
});

describe('biasLabel / biasDefinition / biasGuidance', () => {
  it('resolves known catalog keys to their catalog strings', () => {
    expect(biasLabel('anchoring')).toBe(BIAS_CATALOG.anchoring.label);
    expect(biasDefinition('anchoring')).toBe(
      BIAS_CATALOG.anchoring.definition,
    );
    expect(biasGuidance('anchoring')).toBe(BIAS_CATALOG.anchoring.guidance);
  });

  it('keeps an unknown key legible as its raw label and blanks the prose', () => {
    // The DB stores `bias` as free text, so a persisted row can
    // outlive its catalog entry.
    expect(biasLabel('phantom_bias')).toBe('phantom_bias');
    expect(biasDefinition('phantom_bias')).toBe('');
    expect(biasGuidance('phantom_bias')).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('returns an empty string for null', () => {
    expect(formatTimestamp(null)).toBe('');
  });

  it('locale-formats a valid ISO timestamp', () => {
    const iso = '2026-05-19T12:00:00.000Z';
    expect(formatTimestamp(iso)).toBe(new Date(iso).toLocaleString());
  });
});

describe('formatProbability', () => {
  it('renders tenths-precision percentages', () => {
    expect(formatProbability(0.1234)).toBe('12.3%');
    expect(formatProbability(0)).toBe('0.0%');
    expect(formatProbability(1)).toBe('100.0%');
  });
});

describe('formatEffectiveN', () => {
  it('renders one decimal (the value is a weight sum, not a count)', () => {
    expect(formatEffectiveN(5)).toBe('5.0');
    expect(formatEffectiveN(7.46)).toBe('7.5');
  });
});

describe('formatFeedback', () => {
  it('collapses near-zero to the neutral 0.00 without a sign', () => {
    expect(formatFeedback(0)).toBe('0.00');
    expect(formatFeedback(0.004)).toBe('0.00');
    expect(formatFeedback(-0.004)).toBe('0.00');
  });

  it('forces an explicit sign on meaningful values', () => {
    expect(formatFeedback(0.25)).toBe('+0.25');
    expect(formatFeedback(-0.3)).toBe('-0.30');
  });
});

describe('formatConfidence', () => {
  it('renders whole percents (ingest clamps make tenths noise)', () => {
    expect(formatConfidence(0.72)).toBe('72%');
    expect(formatConfidence(0.4)).toBe('40%');
  });
});

describe('reactionVerdict', () => {
  it('maps the three-state was_confirmed to display words', () => {
    expect(reactionVerdict(true)).toBe('affirmed');
    expect(reactionVerdict(false)).toBe('pushed back');
    expect(reactionVerdict(null)).toBe('neutral');
  });
});

describe('reactionVerdictClass', () => {
  it('returns the CSS key parallel to reactionVerdict', () => {
    expect(reactionVerdictClass(true)).toBe('affirmed');
    expect(reactionVerdictClass(false)).toBe('pushed');
    expect(reactionVerdictClass(null)).toBe('neutral');
  });
});

describe('hasEvidence', () => {
  it('is true only when the bias has at least one raw observation', () => {
    const counts = { anchoring: 2, substitution: 0 };
    expect(hasEvidence(counts, 'anchoring')).toBe(true);
    expect(hasEvidence(counts, 'substitution')).toBe(false);
    expect(hasEvidence(counts, 'never_seen')).toBe(false);
  });
});

describe('interpretBias', () => {
  it('leads with "No evidence" when the bias was never flagged', () => {
    const row = makeRow('a', { tier: 'elided' });
    expect(interpretBias(row, false, false)).toMatch(/^No evidence/);
  });

  it('reports the prior-dominated state with the shortfall below the N floor', () => {
    const row = makeRow('a', { tier: 'elided', effectiveN: 2 });
    const out = interpretBias(row, false, true);
    expect(out).toMatch(/^Mostly prior/);
    expect(out).toContain('about 3.0 more recency-weighted observations');
  });

  it('reports a weak signal for elided rows above the floor', () => {
    const row = makeRow('a', { tier: 'elided', effectiveN: 8, ciLower: 0.08 });
    expect(interpretBias(row, false, true)).toMatch(/^Weak signal/);
  });

  it('describes a rendered soft row as a light nudge', () => {
    const row = makeRow('a', { tier: 'soft', effectiveN: 8, ciLower: 0.18 });
    const out = interpretBias(row, true, true);
    expect(out).toMatch(/^Occasional pattern/);
    expect(out).toContain('light "occasionally" nudge');
  });

  it('notes when an at-tier row is bumped out by the render cap', () => {
    const row = makeRow('a', { tier: 'soft', effectiveN: 8, ciLower: 0.18 });
    expect(interpretBias(row, false, true)).toContain(
      `Outside the top ${RENDER_CAP} by CI lower`,
    );
  });

  it('describes a rendered strong row as a firm nudge', () => {
    const row = makeRow('a', { tier: 'strong', effectiveN: 8, ciLower: 0.35 });
    const out = interpretBias(row, true, true);
    expect(out).toMatch(/^Consistent pattern/);
    expect(out).toContain('firm "consistently" nudge');
  });

  it('appends the gate-shift sentence only when the feedback EMA is meaningful', () => {
    const quiet = makeRow('a', {
      tier: 'soft',
      effectiveN: 8,
      ciLower: 0.18,
      feedbackScore: 0.05,
    });
    expect(interpretBias(quiet, true, true)).not.toContain('Feedback');

    const positive = makeRow('a', {
      tier: 'soft',
      effectiveN: 8,
      ciLower: 0.18,
      feedbackScore: 0.5,
    });
    expect(interpretBias(positive, true, true)).toContain(
      'Feedback +0.50 shifts both gates down by 0.05',
    );

    const negative = makeRow('a', {
      tier: 'soft',
      effectiveN: 8,
      ciLower: 0.18,
      feedbackScore: -0.5,
    });
    expect(interpretBias(negative, true, true)).toContain(
      'Feedback -0.50 shifts both gates up by 0.05',
    );
  });
});

describe('biasHue', () => {
  it('anchors the waypoints to the surfacing gates', () => {
    expect(biasHue(0)).toBe(220); // blue, no signal
    expect(biasHue(0.15)).toBe(140); // green at the soft gate
    expect(biasHue(0.3)).toBe(30); // orange at the strong gate
    expect(biasHue(0.5)).toBe(5); // red, deep into strong
    expect(biasHue(0.9)).toBe(5); // clamped past the last waypoint
  });

  it('interpolates linearly between waypoints', () => {
    expect(biasHue(0.075)).toBeCloseTo(180); // midway blue -> green
    expect(biasHue(0.225)).toBeCloseTo(85); // midway green -> orange
  });
});

describe('chartScale', () => {
  it('never shrinks below the strong gate plus headroom', () => {
    expect(chartScale([])).toBeCloseTo(CI_LB_STRONG * 1.1);
    expect(
      chartScale([makeRow('a', { ciLower: 0.05 })]),
    ).toBeCloseTo(CI_LB_STRONG * 1.1);
  });

  it('extends to the largest ciLower when one clears the floor', () => {
    expect(
      chartScale([
        makeRow('a', { ciLower: 0.5 }),
        makeRow('b', { ciLower: 0.1 }),
      ]),
    ).toBe(0.5);
  });
});

describe('barWidthPct', () => {
  it('pins no-evidence rows to the fixed gray nub regardless of ciLower', () => {
    expect(barWidthPct(0.5, false, 0.5)).toBe(1.5);
  });

  it('renders zero width for a zero ciLower with evidence', () => {
    expect(barWidthPct(0, true, 0.33)).toBe(0);
  });

  it('clamps tiny non-zero values to the 2% visible nub', () => {
    expect(barWidthPct(0.001, true, 0.33)).toBe(2);
  });

  it('scales proportionally otherwise', () => {
    expect(barWidthPct(0.165, true, 0.33)).toBeCloseTo(50);
  });
});

describe('currentObservationsEmptyCopy', () => {
  it('reads as not-yet-analyzed while either fetch is unresolved', () => {
    expect(currentObservationsEmptyCopy(null, null)).toContain(
      'Not yet analyzed',
    );
    // A draft thread's observations query trivially returns [] -
    // the null processedAt is what keeps this from reading as
    // "analyzed, no findings".
    expect(currentObservationsEmptyCopy([], null)).toContain(
      'Not yet analyzed',
    );
  });

  it('reads as analyzed-and-empty once processedAt exists', () => {
    expect(
      currentObservationsEmptyCopy([], '2026-05-19T12:00:00Z'),
    ).toContain('Already analyzed');
  });

  it('returns null when there are observations to render', () => {
    expect(
      currentObservationsEmptyCopy([{}], '2026-05-19T12:00:00Z'),
    ).toBeNull();
  });
});

describe('currentReactionsEmptyCopy', () => {
  const processedAt = '2026-05-19T12:00:00Z';

  it('reads as not-yet-analyzed while either fetch is unresolved', () => {
    expect(currentReactionsEmptyCopy(null, processedAt, 2)).toContain(
      'Not yet analyzed',
    );
    expect(currentReactionsEmptyCopy([], null, 2)).toContain(
      'Not yet analyzed',
    );
  });

  it('returns null when there are reactions to render', () => {
    expect(currentReactionsEmptyCopy([{}], processedAt, 2)).toBeNull();
  });

  it('explains that nothing was active when the rendered set is empty', () => {
    expect(currentReactionsEmptyCopy([], processedAt, 0)).toContain(
      'No biases were active',
    );
  });

  it('reports no-clear-signal when biases were active but no reactions landed', () => {
    expect(currentReactionsEmptyCopy([], processedAt, 2)).toContain(
      'did not see a clear affirmation or pushback signal',
    );
  });
});

describe('displayThreadTitle', () => {
  it('falls back to the bracketed sentinel for null and blank titles', () => {
    expect(displayThreadTitle(null)).toBe('[untitled conversation]');
    expect(displayThreadTitle('   ')).toBe('[untitled conversation]');
  });

  it('trims a real title', () => {
    expect(displayThreadTitle('  Anchors away  ')).toBe('Anchors away');
  });
});

describe('observationsLabel', () => {
  it('pluralizes on the observation count', () => {
    expect(observationsLabel(1)).toBe('1 observation');
    expect(observationsLabel(3)).toBe('3 observations');
    expect(observationsLabel(0)).toBe('0 observations');
  });
});

describe('tierTitle', () => {
  it('expands each tier word into its surfacing meaning', () => {
    expect(tierTitle('elided')).toMatch(/^Elided:/);
    expect(tierTitle('soft')).toMatch(/^Soft:/);
    expect(tierTitle('strong')).toMatch(/^Strong:/);
  });
});

describe('reactionVerdictTitle', () => {
  it('expands each verdict into its feedback meaning', () => {
    expect(reactionVerdictTitle(true)).toMatch(/^Affirmed:/);
    expect(reactionVerdictTitle(false)).toMatch(/^Pushed back:/);
    expect(reactionVerdictTitle(null)).toMatch(/^Neutral:/);
  });
});
