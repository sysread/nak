/**
 * Unit coverage for the clarity UI primitives (src/lib/ui/clarity.ts)
 * and the replay connective's read of them: the defensive jsonb
 * coercion (delegating to the shared module's ONE mapping owner), the
 * failed-set connective per composite case, and the backfill
 * apply-gate predicate (D10). The coercer is the read boundary - a
 * drifting or absent chip must degrade to "render nothing", never
 * throw. Mirrors tests/second-thoughts.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { coerceClarity, rowCarriesDecisionPayload } from '../src/lib/ui/clarity';
import { toVeniceMessage } from '../src/lib/chat/prompt-assembly';
import type { Message } from '../src/lib/supabase';

describe('coerceClarity', () => {
  it('accepts a well-formed v2 chip', () => {
    const chip = {
      v: 2,
      checks: { clarity: 1.2, smoothing: 0.8 },
      failed: ['smoothing'],
      notice: 'straight version incoming',
      rewrite_id: 'row-9',
    };
    expect(coerceClarity(chip)).toEqual(chip);
  });

  it('maps a v1 chip forward with the stored notice preserved (the prod chips)', () => {
    expect(
      coerceClarity({ v: 1, score: 1.2769, notice: 'stored', rewrite_id: 'row-2' }),
    ).toEqual({
      v: 2,
      checks: { clarity: 1.2769, smoothing: null },
      failed: ['clarity'],
      notice: 'stored',
      rewrite_id: 'row-2',
    });
  });

  it('returns null for null / undefined / non-object / unknown versions', () => {
    expect(coerceClarity(null)).toBeNull();
    expect(coerceClarity(undefined)).toBeNull();
    expect(coerceClarity('nope')).toBeNull();
    expect(coerceClarity(42)).toBeNull();
    expect(coerceClarity({ v: 3, notice: 'n', rewrite_id: 'r' })).toBeNull();
  });

  it('requires only what the renderer and the connective read (v, notice, rewrite_id)', () => {
    // checks/failed are best-effort: a drifted chip degrades to a
    // correct notice, never a blanked one.
    expect(coerceClarity({ v: 2, notice: 'n', rewrite_id: 'r' })).toEqual({
      v: 2,
      checks: { clarity: null, smoothing: null },
      failed: [],
      notice: 'n',
      rewrite_id: 'r',
    });
    expect(coerceClarity({ v: 2, notice: 'n' })).toBeNull();
    expect(coerceClarity({ v: 2, rewrite_id: 'r' })).toBeNull();
  });
});

describe('the clarity connective (toVeniceMessage)', () => {
  const base = {
    id: 'row-1',
    thread_id: 't',
    role: 'assistant' as const,
    content: 'the original reply',
    created_at: '2026-01-01T00:00:00Z',
  };

  function msgWithClarity(clarity: unknown): Message {
    return { ...base, clarity } as unknown as Message;
  }

  it('emits the clarity line for a clarity-only failure', () => {
    const out = toVeniceMessage(
      msgWithClarity({ v: 2, checks: { clarity: 1.2, smoothing: 2.9 }, failed: ['clarity'], notice: 'n', rewrite_id: 'r' }),
    );
    expect(out.content).toContain('reworded for clarity');
    expect(out.content).not.toContain('smoothed things over');
  });

  it('emits the smoothing line for a smoothing-only failure - never claims a clarity rewrite', () => {
    const out = toVeniceMessage(
      msgWithClarity({ v: 2, checks: { clarity: 2.9, smoothing: 0.8 }, failed: ['smoothing'], notice: 'n', rewrite_id: 'r' }),
    );
    expect(out.content).toContain('smoothed things over');
    expect(out.content).not.toContain('for clarity');
  });

  it('emits the composite line for a both-check failure', () => {
    const out = toVeniceMessage(
      msgWithClarity({ v: 2, checks: { clarity: 1.2, smoothing: 0.8 }, failed: ['clarity', 'smoothing'], notice: 'n', rewrite_id: 'r' }),
    );
    expect(out.content).toContain('reworded for clarity');
    expect(out.content).toContain('smoothed things over');
  });

  it('emits the clarity line for a v1-mapped chip (true for the B8 chips)', () => {
    const out = toVeniceMessage(
      msgWithClarity({ v: 1, score: 1.27, notice: 'n', rewrite_id: 'r' }),
    );
    expect(out.content).toContain('reworded for clarity');
  });

  it('emits nothing for a null chip', () => {
    const out = toVeniceMessage(msgWithClarity(null));
    expect(out.content).toBe('the original reply');
  });
});

describe('rowCarriesDecisionPayload (the D10 backfill predicate)', () => {
  it('is true for either decision field', () => {
    expect(rowCarriesDecisionPayload({ second_thoughts: { v: 1 } })).toBe(true);
    expect(rowCarriesDecisionPayload({ clarity: { v: 2 } })).toBe(true);
    expect(rowCarriesDecisionPayload({ second_thoughts: { v: 1 }, clarity: { v: 2 } })).toBe(true);
  });

  it('is false for a bare row, null, or undefined', () => {
    expect(rowCarriesDecisionPayload({})).toBe(false);
    expect(rowCarriesDecisionPayload({ second_thoughts: null, clarity: null })).toBe(false);
    expect(rowCarriesDecisionPayload(null)).toBe(false);
    expect(rowCarriesDecisionPayload(undefined)).toBe(false);
  });
});
