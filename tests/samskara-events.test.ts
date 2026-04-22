/**
 * Coverage for the valence->emoji mapping that drives the samskara
 * formation toast. Pure function, so a direct-call test. Keep an
 * eye on the band boundaries: adjusting the bucket widths changes
 * which emoji a minted samskara surfaces for, and the widths were
 * picked deliberately (0.3-wide buckets with the neutral band
 * centered on zero).
 */
import { describe, it, expect } from 'vitest';
import { valenceToEmoji } from '../src/lib/samskara/events';

describe('valenceToEmoji', () => {
  it('maps strongly positive valence to the smiling face', () => {
    expect(valenceToEmoji(1)).toBe('\u{1F60A}');
    expect(valenceToEmoji(0.6)).toBe('\u{1F60A}');
  });

  it('maps mildly positive valence to the slight smile', () => {
    expect(valenceToEmoji(0.59)).toBe('\u{1F642}');
    expect(valenceToEmoji(0.2)).toBe('\u{1F642}');
  });

  it('maps the neutral band to the neutral face', () => {
    expect(valenceToEmoji(0.19)).toBe('\u{1F610}');
    expect(valenceToEmoji(0)).toBe('\u{1F610}');
    expect(valenceToEmoji(-0.19)).toBe('\u{1F610}');
  });

  it('maps mildly negative valence to the confused face', () => {
    expect(valenceToEmoji(-0.2)).toBe('\u{1F615}');
    expect(valenceToEmoji(-0.59)).toBe('\u{1F615}');
  });

  it('maps strongly negative valence to the pensive face', () => {
    expect(valenceToEmoji(-0.6)).toBe('\u{1F614}');
    expect(valenceToEmoji(-1)).toBe('\u{1F614}');
  });

  it('clamps out-of-range values into the top / bottom bucket', () => {
    // Minter already clamps to [-1, 1]; this is defensive for anything
    // that slips past (e.g. a future provenance-weighted aggregate on
    // tier-2 that sums children without re-clamping).
    expect(valenceToEmoji(5)).toBe('\u{1F60A}');
    expect(valenceToEmoji(-5)).toBe('\u{1F614}');
  });
});
