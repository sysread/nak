/**
 * Confidence-tag classifier + formatter. Pure functions, zero deps -
 * covered here in isolation so the thresholds can't drift between the
 * retrieval path (opening-recall, memory_search), the UI (Memories.
 * svelte's chip), and downstream callers.
 *
 * The thresholds themselves are load-bearing: a reviewer tuning one
 * number can accidentally invert a tag ("shaky" memories reading as
 * "hedged") without the rest of the code visibly breaking. These
 * assertions are the tripwire.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMemoryConfidence,
  formatMemoryConfidenceTag,
  MEMORY_CONFIDENCE_CORROBORATED,
  MEMORY_CONFIDENCE_NEUTRAL,
  MEMORY_CONFIDENCE_HEDGED,
} from '../src/lib/memories';

describe('classifyMemoryConfidence — threshold mapping', () => {
  it('labels >= 5.0 as corroborated', () => {
    expect(classifyMemoryConfidence(5.0)).toBe('corroborated');
    expect(classifyMemoryConfidence(10.0)).toBe('corroborated');
    expect(classifyMemoryConfidence(MEMORY_CONFIDENCE_CORROBORATED)).toBe(
      'corroborated'
    );
  });

  it('labels >= 1.5 and < 5.0 as null (neutral, no tag)', () => {
    expect(classifyMemoryConfidence(1.5)).toBeNull();
    expect(classifyMemoryConfidence(2.0)).toBeNull();
    expect(classifyMemoryConfidence(4.9)).toBeNull();
    expect(classifyMemoryConfidence(MEMORY_CONFIDENCE_NEUTRAL)).toBeNull();
  });

  it('labels >= 0.5 and < 1.5 as hedged', () => {
    expect(classifyMemoryConfidence(0.5)).toBe('hedged');
    expect(classifyMemoryConfidence(1.0)).toBe('hedged'); // default memories!
    expect(classifyMemoryConfidence(1.49)).toBe('hedged');
    expect(classifyMemoryConfidence(MEMORY_CONFIDENCE_HEDGED)).toBe('hedged');
  });

  it('labels < 0.5 as shaky', () => {
    expect(classifyMemoryConfidence(0.49)).toBe('shaky');
    expect(classifyMemoryConfidence(0.1)).toBe('shaky');
    // The search-hide floor is 0.05; anything below 0.05 wouldn't
    // surface, but if it did somehow, [shaky] is still the right tag.
    expect(classifyMemoryConfidence(0.01)).toBe('shaky');
  });
});

describe('formatMemoryConfidenceTag — prose prefix', () => {
  it('returns a bracketed prefix with a trailing space for tagged bands', () => {
    expect(formatMemoryConfidenceTag(10.0)).toBe('[corroborated] ');
    expect(formatMemoryConfidenceTag(1.0)).toBe('[hedged] ');
    expect(formatMemoryConfidenceTag(0.1)).toBe('[shaky] ');
  });

  it('returns an empty string (not a space) for the neutral band', () => {
    // Callers append directly to the label; returning a bare space
    // would leave a double gap. Empty-string keeps spacing clean.
    expect(formatMemoryConfidenceTag(2.0)).toBe('');
    expect(formatMemoryConfidenceTag(4.9)).toBe('');
  });
});
