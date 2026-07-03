/**
 * Unit coverage for the mood-legend UI primitives. Pure functions
 * - no runes, no DOM - tested via plain vitest. The primitives read
 * MOOD_TABLE directly (rather than taking it as a parameter) so
 * these tests pin the labels against the live table - the legend
 * can never drift from the mapping the pill actually uses.
 */
import { describe, it, expect } from 'vitest';
import { MOOD_TABLE } from '../src/lib/samskara/events';
import {
  valenceRangeLabel,
  valenceRangeCompactLabel,
  moodDotAriaLabel,
} from '../src/lib/ui/samskara-mood-legend';

const GE = '\u2265';
const LE = '\u2264';

describe('valenceRangeLabel', () => {
  it('renders the top row as unbounded above', () => {
    expect(valenceRangeLabel(0)).toBe(`v ${GE} 0.6`);
  });

  it('renders middle rows as a two-sided range against the previous row', () => {
    expect(valenceRangeLabel(1)).toBe(`0.2 ${LE} v < 0.6`);
    expect(valenceRangeLabel(2)).toBe(`-0.2 ${LE} v < 0.2`);
    expect(valenceRangeLabel(3)).toBe(`-0.6 ${LE} v < -0.2`);
  });

  it('renders the bottom -Infinity row as upper-bound-only', () => {
    // The sentinel must never leak "-Infinity" to the user.
    const bottom = MOOD_TABLE.length - 1;
    expect(valenceRangeLabel(bottom)).toBe('v < -0.6');
    expect(valenceRangeLabel(bottom)).not.toContain('Infinity');
  });
});

describe('valenceRangeCompactLabel', () => {
  it('shows the lower bound for every row except the bottom one', () => {
    expect(valenceRangeCompactLabel(0)).toBe(`${GE} 0.6`);
    expect(valenceRangeCompactLabel(3)).toBe(`${GE} -0.6`);
  });

  it('shows the upper bound for the bottom -Infinity row', () => {
    expect(valenceRangeCompactLabel(MOOD_TABLE.length - 1)).toBe('< -0.6');
  });
});

describe('moodDotAriaLabel', () => {
  it('names the cell and renders both scalars at two decimals', () => {
    expect(moodDotAriaLabel('content', 0.8, 0.25)).toBe(
      'Pill currently here: content, confidence 0.80, valence 0.25',
    );
  });
});
