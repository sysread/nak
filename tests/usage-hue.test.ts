/**
 * Unit coverage for relativeHue - the median-anchored log-scale color mapping
 * the Usage pane uses for both the bar hue (over tokens) and the spend-pill
 * border hue (over dollars). Populations are built from exact powers of e so
 * the log values land on clean integers and the median/min/max anchors are
 * obvious.
 */
import { describe, it, expect } from 'vitest';
import { relativeHue } from '../src/lib/ui/usage';

// logs sorted -> [0, 1, 2], median = 1, min = 0, max = 2.
const POP = [Math.E ** 0, Math.E ** 1, Math.E ** 2];

describe('relativeHue', () => {
  it('returns the neutral median hue for a non-positive value', () => {
    expect(relativeHue(0, POP)).toBe(140);
    expect(relativeHue(-5, POP)).toBe(140);
  });

  it('returns the neutral median hue when the population is empty', () => {
    expect(relativeHue(10, [])).toBe(140);
    expect(relativeHue(10, [0, -1])).toBe(140); // all filtered out
  });

  it('puts the population median at green (140)', () => {
    expect(relativeHue(Math.E ** 1, POP)).toBe(140);
  });

  it('puts the largest member at red (5)', () => {
    expect(relativeHue(Math.E ** 2, POP)).toBe(5);
  });

  it('puts the smallest member at blue (220)', () => {
    expect(relativeHue(Math.E ** 0, POP)).toBe(220);
  });

  it('clamps a value above the population max to the red endpoint', () => {
    expect(relativeHue(Math.E ** 5, POP)).toBe(5);
  });

  it('clamps a value below the population min to the blue endpoint', () => {
    expect(relativeHue(Math.E ** -3, POP)).toBe(220);
  });

  it('is monotonic: a larger value yields a hue closer to red', () => {
    const small = relativeHue(Math.E ** 0.5, POP);
    const mid = relativeHue(Math.E ** 1, POP);
    const large = relativeHue(Math.E ** 1.5, POP);
    expect(small).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(large);
  });

  it('sits a single-member population at the median hue', () => {
    // median == min == max, so every position collapses to 0 (green).
    expect(relativeHue(42, [42])).toBe(140);
  });
});
