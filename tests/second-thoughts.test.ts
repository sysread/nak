/**
 * Unit coverage for the second-thoughts UI primitives
 * (src/lib/ui/second-thoughts.ts): the defensive jsonb coercion and
 * the disposition-to-display maps the panel renders from. The coercer
 * is the read boundary - a drifting or absent verdict must degrade to
 * "render nothing", never throw.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRefinementThink,
  coerceSecondThoughts,
  dispositionAction,
  dispositionHeadline,
  dispositionIcon,
  dispositionLabel,
  dispositionTone,
  displayNote,
  SECOND_THOUGHTS_DISPOSITIONS,
} from '../src/lib/ui/second-thoughts';
import { toVeniceMessage } from '../src/lib/chat/prompt-assembly';
import type { Message } from '../src/lib/supabase';

describe('coerceSecondThoughts', () => {
  it('accepts a well-formed v1 verdict', () => {
    const v = coerceSecondThoughts({
      v: 1,
      disposition: 'correct',
      note: 'I think the acreage was a guess.',
      model: 'mistral-small-3-2-24b-instruct',
      computed_at: 123,
    });
    expect(v).toEqual({
      disposition: 'correct',
      note: 'I think the acreage was a guess.',
      acted: false,
    });
  });

  it('trims the note', () => {
    const v = coerceSecondThoughts({ v: 1, disposition: 'hedge', note: '  soft  ' });
    expect(v?.note).toBe('soft');
  });

  it('defaults a missing note to empty string and acted to false', () => {
    const v = coerceSecondThoughts({ v: 1, disposition: 'conviction' });
    expect(v).toEqual({ disposition: 'conviction', note: '', acted: false });
  });

  it('reads the acted flag when the user has acted on the doubt', () => {
    const v = coerceSecondThoughts({ v: 1, disposition: 'correct', note: 'x', acted: true });
    expect(v?.acted).toBe(true);
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

describe('dispositionAction', () => {
  it('returns null for conviction (no button, no auto-expand)', () => {
    expect(dispositionAction('conviction')).toBeNull();
  });

  it('returns a distinct label for each doubt disposition', () => {
    const hedge = dispositionAction('hedge');
    const reframe = dispositionAction('reframe');
    const correct = dispositionAction('correct');
    expect(hedge).toBeTruthy();
    expect(reframe).toBeTruthy();
    expect(correct).toBeTruthy();
    // Distinct so the button feels personalized per disposition.
    expect(new Set([hedge, reframe, correct]).size).toBe(3);
  });
});

describe('buildRefinementThink', () => {
  it('wraps the note in a think block with the misgiving', () => {
    const out = buildRefinementThink('I may have the acreage wrong.');
    expect(out.startsWith('<think>')).toBe(true);
    expect(out.trimEnd().endsWith('</think>')).toBe(true);
    expect(out).toContain('I may have the acreage wrong.');
  });

  it('permits rejection - never frames the doubt as a command', () => {
    const out = buildRefinementThink('x').toLowerCase();
    // The load-bearing safety valve: the strong model must be free to
    // stand by its original answer.
    expect(out).toContain('stand by');
    expect(out).not.toContain('fix these');
  });

  it('marks the reply that follows as the current, authoritative answer', () => {
    // Resolves the cascade/hedging gap: on replay the model must know
    // the refinement supersedes the original, not waffle between them.
    const out = buildRefinementThink('x').toLowerCase();
    expect(out).toContain('prefer it');
  });

  it('supplies a fallback misgiving when the note is empty', () => {
    const out = buildRefinementThink('   ');
    expect(out).toContain('<think>');
    expect(out.toLowerCase()).toContain('feels off');
  });
});

describe('displayNote', () => {
  it('returns the note verbatim when present', () => {
    expect(displayNote({ disposition: 'hedge', note: 'a caveat', acted: false })).toBe(
      'a caveat'
    );
  });

  it('falls back to a calm line for empty conviction', () => {
    const out = displayNote({ disposition: 'conviction', note: '', acted: false });
    expect(out.length).toBeGreaterThan(0);
    expect(out.toLowerCase()).toContain('no misgivings');
  });

  it('falls back to a generic line for empty doubt', () => {
    const out = displayNote({ disposition: 'correct', note: '', acted: false });
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('toVeniceMessage second-thoughts projection', () => {
  const base: Message = {
    id: '1',
    thread_id: 't',
    role: 'assistant',
    content: 'The answer is 42.',
    created_at: '2026-01-01T00:00:00Z',
  };

  it('leaves a verdict-less or un-acted answer clean', () => {
    expect(toVeniceMessage({ ...base }).content).toBe('The answer is 42.');
    const unacted = toVeniceMessage({
      ...base,
      second_thoughts: { v: 1, disposition: 'correct', note: 'hmm', acted: false },
    });
    // An un-acted doubt stays invisible to the model.
    expect(unacted.content).toBe('The answer is 42.');
  });

  it('appends the <think> connective once the doubt was acted on', () => {
    const out = toVeniceMessage({
      ...base,
      second_thoughts: {
        v: 1,
        disposition: 'correct',
        note: 'the acreage may be off',
        acted: true,
      },
    });
    expect(typeof out.content).toBe('string');
    const content = out.content as string;
    expect(content).toContain('The answer is 42.');
    expect(content).toContain('<think>');
    expect(content).toContain('the acreage may be off');
  });
});
