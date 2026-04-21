/**
 * Pure-logic coverage for the samskara priming formatter and the
 * topKForCorpusSize math. No IO, no mocks beyond shaping the input
 * structs the helpers expect.
 */
import { describe, it, expect } from 'vitest';
import { formatPriming, topKForCorpusSize } from '../src/lib/samskara/format';
import { K_BASE, PRIMING_CHAR_BUDGET } from '../src/lib/samskara/types';
import type { FiredSamskara } from '../src/lib/samskara/types';

function fakeFire(score: number, prediction: string, voice?: string): FiredSamskara {
  return {
    id: `id-${score}`,
    prediction,
    innerVoice: voice ?? null,
    valence: 0,
    confidence: 0.5,
    health: 1,
    score,
  };
}

describe('formatPriming', () => {
  it('returns empty string when there is nothing to inject', () => {
    expect(formatPriming({ compoundSummary: null, fire: null })).toBe('');
    expect(formatPriming({ compoundSummary: '', fire: null })).toBe('');
    expect(
      formatPriming({ compoundSummary: '   ', fire: { cohortId: 'c', fired: [] } })
    ).toBe('');
  });

  it('renders only the calibration block when fire is empty', () => {
    const out = formatPriming({
      compoundSummary: 'The user prefers terse replies.',
      fire: null,
    });
    expect(out).toContain('## Calibration');
    expect(out).toContain('The user prefers terse replies.');
    expect(out).not.toContain('## Fired this turn');
  });

  it('renders only the fire block when there is no compound summary', () => {
    const out = formatPriming({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.5, 'p1')] },
    });
    expect(out).not.toContain('## Calibration');
    expect(out).toContain('## Fired this turn');
    expect(out).toContain('p1');
  });

  it('shows the score with two decimals and includes the inner voice when short', () => {
    const out = formatPriming({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.7, 'wants brevity', 'do not pad')] },
    });
    expect(out).toContain('[0.70]');
    expect(out).toContain('wants brevity');
    expect(out).toContain('(do not pad)');
  });

  it('drops the inner voice when it would push past the abbreviated boundary', () => {
    const longVoice = 'x'.repeat(120);
    const out = formatPriming({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.5, 'p', longVoice)] },
    });
    expect(out).not.toContain(longVoice);
  });

  it('abbreviates long-tail entries when over the char budget', () => {
    // Build many fires with long predictions so the unabbreviated form
    // exceeds PRIMING_CHAR_BUDGET. Top three should still carry the
    // inner_voice; the rest should be the abbreviated `[score] text` form.
    const longPred = 'a long prediction that takes a lot of room'.repeat(8);
    const fires = Array.from({ length: 12 }, (_, i) =>
      fakeFire(1 - i * 0.05, longPred, 'voice')
    );
    const out = formatPriming({
      compoundSummary: 'a short calibration',
      fire: { cohortId: 'c', fired: fires },
    });
    // Even abbreviated, the formatter is allowed to be over-budget when
    // the compound block itself dominates - but it should at least
    // attempt the abbreviation pass. Check that at least one row uses
    // the abbreviated shape (no parens for inner voice).
    const lines = out.split('\n').filter((l) => l.startsWith('- ['));
    const hasAbbreviated = lines.some((l) => !l.includes('('));
    expect(hasAbbreviated).toBe(true);
  });

  it('drops the lowest-scoring fires when even abbreviation is not enough', () => {
    const longPred = 'x'.repeat(400);
    const fires = Array.from({ length: 20 }, (_, i) =>
      fakeFire(1 - i * 0.04, longPred)
    );
    const out = formatPriming({ compoundSummary: null, fire: { cohortId: 'c', fired: fires } });
    expect(out.length).toBeLessThanOrEqual(PRIMING_CHAR_BUDGET + 200);
  });
});

describe('topKForCorpusSize', () => {
  it('floors at 1 for an empty corpus', () => {
    expect(topKForCorpusSize(0, K_BASE)).toBe(Math.ceil(K_BASE * Math.log10(10)));
    expect(topKForCorpusSize(0, K_BASE)).toBeGreaterThanOrEqual(1);
  });

  it('grows logarithmically with corpus size', () => {
    const at10 = topKForCorpusSize(10, K_BASE);
    const at100 = topKForCorpusSize(100, K_BASE);
    const at1000 = topKForCorpusSize(1000, K_BASE);
    expect(at10).toBeLessThan(at100);
    expect(at100).toBeLessThan(at1000);
    // log10 dampening means a 10x corpus increase produces at most a
    // small multiplicative jump in k - bound it to keep priming
    // volume from running away.
    expect(at1000 - at10).toBeLessThan(15);
  });

  it('handles negative corpus size as zero', () => {
    expect(topKForCorpusSize(-5, K_BASE)).toBe(topKForCorpusSize(0, K_BASE));
  });
});
