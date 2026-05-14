/**
 * Pure-logic coverage for the samskara priming formatter and the
 * topKForCorpusSize math. No IO, no mocks beyond shaping the input
 * structs the helpers expect.
 */
import { describe, it, expect } from 'vitest';
import { formatPrimingThinks, topKForCorpusSize } from '../src/lib/samskara/format';
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

describe('formatPrimingThinks', () => {
  it('returns both fields null when there is nothing to inject', () => {
    expect(formatPrimingThinks({ compoundSummary: null, fire: null })).toEqual({
      compound: null,
      fire: null,
    });
    expect(formatPrimingThinks({ compoundSummary: '', fire: null })).toEqual({
      compound: null,
      fire: null,
    });
    expect(
      formatPrimingThinks({ compoundSummary: '   ', fire: { cohortId: 'c', fired: [] } }),
    ).toEqual({ compound: null, fire: null });
  });

  it('returns just the compound body when fire is empty', () => {
    const out = formatPrimingThinks({
      compoundSummary: 'The user prefers terse replies.',
      fire: null,
    });
    expect(out.compound).toBe('The user prefers terse replies.');
    expect(out.fire).toBeNull();
  });

  it('returns just the fire body when there is no compound summary', () => {
    const out = formatPrimingThinks({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.5, 'wants brevity')] },
    });
    expect(out.compound).toBeNull();
    expect(out.fire).not.toBeNull();
    // The fire body opens with a short orientation sentence so the
    // bullets read as observations the assistant is recalling.
    expect(out.fire).toMatch(/come to expect/);
    expect(out.fire).toContain('- wants brevity');
  });

  it('keys the parenthetical confidence hedge off the score', () => {
    // Four score bands map to four hedges. Each hedge leads with a
    // first-person pronoun or fragment so the bullet reads in voice.
    const high = formatPrimingThinks({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(1.1, 'is decisive')] },
    });
    expect(high.fire).toContain("(I'm pretty sure)");

    const mid = formatPrimingThinks({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.8, 'plans carefully')] },
    });
    expect(mid.fire).toContain('(fairly confident)');

    const lower = formatPrimingThinks({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.5, 'wants brevity')] },
    });
    expect(lower.fire).toContain('(I think)');

    const hunch = formatPrimingThinks({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.2, 'might agree')] },
    });
    expect(hunch.fire).toContain('(just a hunch)');
  });

  it('quotes the inner voice when it is short, drops it when long', () => {
    const short = formatPrimingThinks({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.5, 'wants brevity', 'do not pad')] },
    });
    expect(short.fire).toContain('inner voice: "do not pad"');

    const longVoice = 'x'.repeat(120);
    const long = formatPrimingThinks({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: [fakeFire(0.5, 'p', longVoice)] },
    });
    expect(long.fire).not.toContain(longVoice);
    expect(long.fire).not.toContain('inner voice:');
  });

  it('abbreviates long-tail entries when over the char budget', () => {
    // Build many fires with long predictions so the unabbreviated form
    // exceeds PRIMING_CHAR_BUDGET. Top three should still carry the
    // inner voice; the rest should be the abbreviated form (no inner
    // voice clause).
    const longPred = 'a long prediction that takes a lot of room'.repeat(8);
    const fires = Array.from({ length: 12 }, (_, i) =>
      fakeFire(1 - i * 0.05, longPred, 'voice'),
    );
    const out = formatPrimingThinks({
      compoundSummary: 'a short calibration',
      fire: { cohortId: 'c', fired: fires },
    });
    expect(out.fire).not.toBeNull();
    // Find lines starting with the bullet marker and check that at
    // least one row landed in the abbreviated shape (no inner-voice
    // clause).
    const lines = out.fire!.split('\n').filter((l) => l.startsWith('- '));
    const hasAbbreviated = lines.some((l) => !l.includes('inner voice:'));
    expect(hasAbbreviated).toBe(true);
  });

  it('drops the lowest-scoring fires when even abbreviation is not enough', () => {
    const longPred = 'x'.repeat(400);
    const fires = Array.from({ length: 20 }, (_, i) =>
      fakeFire(1 - i * 0.04, longPred),
    );
    const out = formatPrimingThinks({
      compoundSummary: null,
      fire: { cohortId: 'c', fired: fires },
    });
    expect(out.fire).not.toBeNull();
    // The body lives inside an orientation paragraph; the budget
    // applies to the bullet body itself. Allow a small overhead
    // tolerance for the orientation lines.
    expect(out.fire!.length).toBeLessThanOrEqual(PRIMING_CHAR_BUDGET + 300);
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
