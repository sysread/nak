/**
 * Unit coverage for the second-thoughts UI primitives
 * (src/lib/ui/second-thoughts.ts): the defensive jsonb coercion and
 * the disposition-to-display maps the panel renders from. The coercer
 * is the read boundary - a drifting or absent verdict must degrade to
 * "render nothing", never throw.
 */
import { describe, it, expect } from 'vitest';
import {
  coerceSecondThoughts,
  dispositionHeadline,
  dispositionIcon,
  dispositionLabel,
  dispositionTone,
  displayNote,
  SECOND_THOUGHTS_DISPOSITIONS,
} from '../src/lib/ui/second-thoughts';

describe('coerceSecondThoughts', () => {
  it('accepts a well-formed v1 verdict', () => {
    const v = coerceSecondThoughts({
      v: 1,
      disposition: 'correct',
      note: 'I think the acreage was a guess.',
      model: 'xiaomi-mimo-v2-5',
      computed_at: 123,
    });
    expect(v).toEqual({
      disposition: 'correct',
      note: 'I think the acreage was a guess.',
    });
  });

  it('trims the note', () => {
    const v = coerceSecondThoughts({ v: 1, disposition: 'hedge', note: '  soft  ' });
    expect(v?.note).toBe('soft');
  });

  it('defaults a missing note to empty string', () => {
    const v = coerceSecondThoughts({ v: 1, disposition: 'conviction' });
    expect(v).toEqual({ disposition: 'conviction', note: '' });
  });

  it('returns null for null / undefined / non-object', () => {
    expect(coerceSecondThoughts(null)).toBeNull();
    expect(coerceSecondThoughts(undefined)).toBeNull();
    expect(coerceSecondThoughts('nope')).toBeNull();
    expect(coerceSecondThoughts(42)).toBeNull();
  });

  it('returns null for an unknown schema version', () => {
    expect(coerceSecondThoughts({ v: 2, disposition: 'conviction', note: '' })).toBeNull();
  });

  it('returns null for an unknown disposition', () => {
    expect(coerceSecondThoughts({ v: 1, disposition: 'panic', note: '' })).toBeNull();
  });

  it('returns null when disposition is missing', () => {
    expect(coerceSecondThoughts({ v: 1, note: 'x' })).toBeNull();
  });
});

describe('disposition maps', () => {
  it('covers every disposition in each map (no undefined fallthrough)', () => {
    for (const d of SECOND_THOUGHTS_DISPOSITIONS) {
      expect(typeof dispositionLabel(d)).toBe('string');
      expect(dispositionLabel(d).length).toBeGreaterThan(0);
      expect(typeof dispositionHeadline(d)).toBe('string');
      expect(['calm', 'unease', 'alert']).toContain(dispositionTone(d));
      expect(['check', 'hedge', 'reframe', 'alert']).toContain(dispositionIcon(d));
    }
  });

  it('routes tone: conviction calm, hedge/reframe unease, correct alert', () => {
    expect(dispositionTone('conviction')).toBe('calm');
    expect(dispositionTone('hedge')).toBe('unease');
    expect(dispositionTone('reframe')).toBe('unease');
    expect(dispositionTone('correct')).toBe('alert');
  });
});

describe('displayNote', () => {
  it('returns the note verbatim when present', () => {
    expect(displayNote({ disposition: 'hedge', note: 'a caveat' })).toBe('a caveat');
  });

  it('falls back to a calm line for empty conviction', () => {
    const out = displayNote({ disposition: 'conviction', note: '' });
    expect(out.length).toBeGreaterThan(0);
    expect(out.toLowerCase()).toContain('no misgivings');
  });

  it('falls back to a generic line for empty doubt', () => {
    const out = displayNote({ disposition: 'correct', note: '' });
    expect(out.length).toBeGreaterThan(0);
  });
});
