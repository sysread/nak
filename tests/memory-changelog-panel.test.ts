/**
 * Coverage for the memory-changelog panel's primitives, focused on the
 * size-delta chip.
 *
 * The chip exists to make memory-body size drift visible: bodies are
 * replayed verbatim into every recall prompt, so an edit that grew a
 * memory costs tokens on every future turn. The rules that matter are
 * (1) never invent a delta from a row whose sizes were not recorded,
 * and (2) stay quiet about changes too small to mean anything.
 */
import { describe, expect, it } from 'vitest';
import { memorySizeDelta } from '../src/lib/ui/memory-changelog-panel';

function entry(before: number | null, after: number | null) {
  return { chars_before: before, chars_after: after };
}

describe('memorySizeDelta', () => {
  it('renders a signed, thousands-separated label', () => {
    expect(memorySizeDelta(entry(1000, 2400))?.label).toBe('+1,400');
    expect(memorySizeDelta(entry(4000, 1500))?.label).toBe('-2,500');
  });

  it('carries the signed magnitude for the caller to style direction', () => {
    expect(memorySizeDelta(entry(1000, 2400))?.chars).toBe(1400);
    expect(memorySizeDelta(entry(4000, 1500))?.chars).toBe(-2500);
  });

  // A pre-columns row has unrecoverable historical sizes. Rendering
  // anything here would imply a zero-length body that never existed.
  it('shows nothing when either size is unknown', () => {
    expect(memorySizeDelta(entry(null, 2400))).toBeNull();
    expect(memorySizeDelta(entry(1000, null))).toBeNull();
    expect(memorySizeDelta(entry(null, null))).toBeNull();
  });

  // 0 is a real recorded value, unlike null: a create has nothing before
  // it and a delete nothing after, and both are worth showing.
  it('treats a recorded zero as a real size, not a missing one', () => {
    expect(memorySizeDelta(entry(0, 1800))?.label).toBe('+1,800');
    expect(memorySizeDelta(entry(1800, 0))?.label).toBe('-1,800');
  });

  it('stays quiet on a label-only edit and on sub-noise churn', () => {
    expect(memorySizeDelta(entry(2000, 2000))).toBeNull();
    expect(memorySizeDelta(entry(2000, 2050))).toBeNull();
    expect(memorySizeDelta(entry(2000, 1950))).toBeNull();
  });

  it('emphasizes only the large moves', () => {
    expect(memorySizeDelta(entry(2000, 2200))?.significant).toBe(false);
    expect(memorySizeDelta(entry(2000, 4000))?.significant).toBe(true);
    expect(memorySizeDelta(entry(6000, 2000))?.significant).toBe(true);
  });
});
