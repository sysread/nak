/**
 * Pure-logic coverage for the context-recall payload shape: the
 * jsonb coercion path, the freshness merge, and the contract that
 * an empty `note` is a VALID cached state (not a missing one).
 */
import { describe, it, expect } from 'vitest';
import {
  coerceContextRecallPayload,
  pickFresherContextRecallPayload,
  type ContextRecallPayload,
} from '../src/lib/context-recall/types';

function payload(
  overrides: Partial<ContextRecallPayload> = {}
): ContextRecallPayload {
  return {
    v: 2,
    note: 'I remember the user prefers concrete examples.',
    citations: [],
    computed_at_round: 1,
    computed_at_band: 2,
    computed_at_column: 'confident',
    computed_at_at: 1_700_000_000_000,
    trigger: 'cold',
    ...overrides,
  };
}

describe('coerceContextRecallPayload', () => {
  it('returns null for non-object input', () => {
    expect(coerceContextRecallPayload(null)).toBeNull();
    expect(coerceContextRecallPayload(undefined)).toBeNull();
    expect(coerceContextRecallPayload(42)).toBeNull();
    expect(coerceContextRecallPayload('hi')).toBeNull();
    expect(coerceContextRecallPayload([])).toBeNull();
  });

  it('returns null when version is anything other than 2', () => {
    // v1 is the pre-smoothing shape (note only, no citations); it must
    // coerce to null so the next trigger recomputes into the v2 shape.
    expect(coerceContextRecallPayload({ ...payload(), v: 1 })).toBeNull();
    expect(coerceContextRecallPayload({ ...payload(), v: 3 })).toBeNull();
  });

  it('treats an empty note as a valid cached state', () => {
    // Empty string represents "both children returned the empty signal
    // this round" - cached so the same-round debounce holds. Coercion
    // must NOT collapse that to null.
    const out = coerceContextRecallPayload(payload({ note: '' }));
    expect(out).not.toBeNull();
    expect(out?.note).toBe('');
  });

  it('rejects a payload whose note is not a string', () => {
    expect(
      coerceContextRecallPayload({ ...payload(), note: null })
    ).toBeNull();
    expect(
      coerceContextRecallPayload({ ...payload(), note: 42 })
    ).toBeNull();
  });

  it('accepts null mood band/column (cold-start with no mood)', () => {
    const out = coerceContextRecallPayload(
      payload({ computed_at_band: null, computed_at_column: null })
    );
    expect(out).not.toBeNull();
    expect(out?.computed_at_band).toBeNull();
    expect(out?.computed_at_column).toBeNull();
  });

  it('rejects an unrecognised trigger value', () => {
    expect(
      coerceContextRecallPayload({ ...payload(), trigger: 'whatever' })
    ).toBeNull();
  });

  it('rejects a non-numeric computed_at_round', () => {
    expect(
      coerceContextRecallPayload({
        ...payload(),
        computed_at_round: 'one',
      })
    ).toBeNull();
    expect(
      coerceContextRecallPayload({
        ...payload(),
        computed_at_round: NaN,
      })
    ).toBeNull();
  });

  it('rejects a non-numeric computed_at_at', () => {
    expect(
      coerceContextRecallPayload({ ...payload(), computed_at_at: 'now' })
    ).toBeNull();
    expect(
      coerceContextRecallPayload({ ...payload(), computed_at_at: NaN })
    ).toBeNull();
  });

  it('round-trips a valid payload unchanged', () => {
    const p = payload({
      note: 'I remember X ^1^. From earlier conversations, Y ^2^.',
      citations: [
        { index: 1, kind: 'memory', id: 'm1', label: 'X fact' },
        { index: 2, kind: 'conversation', id: 'c1', label: 'Y thread' },
      ],
      computed_at_round: 5,
      trigger: 'title',
    });
    expect(coerceContextRecallPayload(p)).toEqual(p);
  });

  it('treats a missing or non-array citations field as empty (best-effort)', () => {
    // Citations are metadata, not load-bearing like note - a glitch must
    // not invalidate the whole payload and drop the recollection.
    const withoutCitations: Record<string, unknown> = { ...payload() };
    delete withoutCitations.citations;
    expect(coerceContextRecallPayload(withoutCitations)?.citations).toEqual([]);
    expect(
      coerceContextRecallPayload({ ...payload(), citations: 'nope' })?.citations
    ).toEqual([]);
  });

  it('drops malformed citation entries but keeps the clean ones', () => {
    const out = coerceContextRecallPayload(
      payload({
        citations: [
          { index: 1, kind: 'memory', id: 'm1', label: 'ok' },
          { index: 2, kind: 'bogus', id: 'x', label: 'bad kind' },
          { index: 3, kind: 'wiki', id: '', label: 'empty id' },
          { kind: 'memory', id: 'm2', label: 'no index' },
          { index: 4, kind: 'conversation', id: 'c1', label: 'ok2' },
        ] as unknown as ContextRecallPayload['citations'],
      })
    );
    expect(out?.citations).toEqual([
      { index: 1, kind: 'memory', id: 'm1', label: 'ok' },
      { index: 4, kind: 'conversation', id: 'c1', label: 'ok2' },
    ]);
  });
});

describe('pickFresherContextRecallPayload', () => {
  it('keeps the incoming payload when existing is null', () => {
    const incoming = payload();
    expect(
      pickFresherContextRecallPayload(null, incoming)
    ).toBe(incoming);
  });

  it('keeps the existing payload when incoming is null', () => {
    const existing = payload();
    expect(
      pickFresherContextRecallPayload(existing, null)
    ).toBe(existing);
  });

  it('returns the incoming payload when its computed_at_at is later', () => {
    const existing = payload({ computed_at_at: 1_700_000_000_000 });
    const incoming = payload({ computed_at_at: 1_700_000_001_000 });
    expect(
      pickFresherContextRecallPayload(existing, incoming)
    ).toBe(incoming);
  });

  it('returns the existing payload when it is newer than incoming', () => {
    const existing = payload({ computed_at_at: 1_700_000_001_000 });
    const incoming = payload({ computed_at_at: 1_700_000_000_000 });
    expect(
      pickFresherContextRecallPayload(existing, incoming)
    ).toBe(existing);
  });

  it('treats a malformed existing as null (incoming wins)', () => {
    const incoming = payload();
    expect(
      pickFresherContextRecallPayload({ v: 99, note: 'bad' }, incoming)
    ).toBe(incoming);
  });

  it('treats a malformed incoming as null (existing wins)', () => {
    const existing = payload();
    expect(
      pickFresherContextRecallPayload(existing, { v: 99, note: 'bad' })
    ).toBe(existing);
  });
});
