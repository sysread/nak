/**
 * Unit coverage for the reasoning-panel UI primitives. Pure functions -
 * no runes, no DOM - tested via plain vitest.
 *
 * The companion wiring (when the live panel actually collapses, the
 * elapsed-ms rAF ticker, the manual-toggle latch) lives in Chat.svelte
 * + ExchangeSlot; a port to another framework would reuse this module
 * untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  reasoningShouldCollapse,
  reasoningElapsedPill,
  reasoningCharPill,
} from '../src/lib/ui/reasoning-panel';

// Mirrors the module's FLOOR / CEILING so the boundary cases below read
// against named lengths rather than bare magic numbers.
const FLOOR = 80;
const CEILING = 600;
const pad = (n: number): string => 'x'.repeat(n);

describe('reasoningShouldCollapse', () => {
  it('keeps a short thought open (below the floor, even with a sentence end)', () => {
    // A lone short sentence is worth reading in full - it never crosses
    // the floor, so no collapse.
    expect(reasoningShouldCollapse('Let me think about this. ')).toBe(false);
    expect(reasoningShouldCollapse('')).toBe(false);
  });

  it('does not collapse on an early numbered-list marker', () => {
    // "1. " matches the sentence-terminator regex, but it lands well
    // before the floor, so it must not trigger a premature collapse -
    // this is the failure mode the floor exists to prevent.
    expect(reasoningShouldCollapse('Plan:\n1. first step here')).toBe(false);
  });

  it('does not collapse on an early abbreviation', () => {
    // "e.g. " likewise matches the regex early; the floor skips it.
    expect(reasoningShouldCollapse('I should consider, e.g. the edge')).toBe(
      false
    );
  });

  it('collapses at the first sentence boundary past the floor', () => {
    // Floor-plus of filler with no boundary, then a sentence end: the
    // terminator sits past the floor, so it collapses.
    const text = pad(FLOOR) + 'and then it is done. and more';
    expect(reasoningShouldCollapse(text)).toBe(true);
  });

  it('stays open past the floor until a boundary actually appears', () => {
    // Past the floor but no terminal punctuation yet (a run-on still in
    // flight, under the ceiling): hold open.
    const text = pad(FLOOR) + ' still going with no end in sight yet';
    expect(text.length).toBeLessThan(CEILING);
    expect(reasoningShouldCollapse(text)).toBe(false);
  });

  it('collapses at the ceiling even with no sentence boundary', () => {
    // A wall of fragments with no terminal punctuation can't stay open
    // forever; the ceiling forces the tuck.
    const text = pad(CEILING + 10);
    expect(reasoningShouldCollapse(text)).toBe(true);
  });

  it('detects a boundary closed by a quote or paren', () => {
    const quoted = pad(FLOOR) + ' as the model put it.” next';
    const paren = pad(FLOOR) + ' (a side note here.) next';
    expect(reasoningShouldCollapse(quoted.replace('”', '"'))).toBe(true);
    expect(reasoningShouldCollapse(paren)).toBe(true);
  });

  it('treats a newline as boundary whitespace', () => {
    const text = pad(FLOOR) + ' that wraps the first thought.\nThen';
    expect(reasoningShouldCollapse(text)).toBe(true);
  });

  it('waits for the trailing whitespace (no collapse on a bare tail period)', () => {
    // The terminator needs a following space/newline; a period at the
    // very end of the buffer isn't a boundary until the next delta.
    const text = pad(FLOOR) + ' ending with no trailing space.';
    expect(reasoningShouldCollapse(text)).toBe(false);
  });
});

describe('reasoningElapsedPill', () => {
  it('is null before reasoning has started', () => {
    expect(reasoningElapsedPill(null, null, 1000)).toBe(null);
  });

  it('counts up against nowMs while reasoning streams', () => {
    expect(reasoningElapsedPill(1000, null, 1432)).toBe('432 ms');
  });

  it('freezes at the final duration once ended', () => {
    // nowMs has moved on, but endedAt pins the value.
    expect(reasoningElapsedPill(1000, 5200, 9999)).toBe('4200 ms');
  });

  it('clamps a backwards clock to zero rather than going negative', () => {
    expect(reasoningElapsedPill(1000, null, 900)).toBe('0 ms');
  });
});

describe('reasoningCharPill', () => {
  it('is null with nothing to count', () => {
    expect(reasoningCharPill(0)).toBe(null);
  });

  it('uses the singular noun at one char', () => {
    expect(reasoningCharPill(1)).toBe('1 char');
  });

  it('groups thousands and pluralizes', () => {
    expect(reasoningCharPill(42)).toBe('42 chars');
    // Separator is locale-dependent (toLocaleString, no pinned locale,
    // matching the rest of the codebase); assert against the same call
    // so the test holds whatever ICU the runner ships.
    expect(reasoningCharPill(1234)).toBe(`${(1234).toLocaleString()} chars`);
  });
});
