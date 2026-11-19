/**
 * Browser-side coercion tests for the intuition payload
 * (src/lib/intuition/types.ts) - the twin of the Deno-side coercer
 * (supabase/functions/priming/intuition-payload.ts, covered by
 * tests/priming-payloads.test.ts). The two coercers are duplicated
 * declarations that cannot share an import (Deno vs vite/tsc), so
 * nothing enforces lockstep except these tests: a twin edit missed on
 * one side (e.g. accepting the pivot gate's 'pivot' trigger) has to
 * fail HERE.
 */
import { describe, it, expect } from 'vitest';
import { coerceIntuitionPayload, type IntuitionPayload } from '../src/lib/intuition/types';

function payload(overrides: Partial<IntuitionPayload> = {}): IntuitionPayload {
  return {
    v: 1,
    perception: 'Classification: cooking planning',
    drives: { curiosity: 'The pasta questions keep coming.' },
    synthesis: 'The user is mid-meal-prep and thinking aloud.',
    computed_at_round: 1,
    computed_at_band: 2,
    computed_at_column: 'confident',
    computed_at_at: 1_700_000_000_000,
    trigger: 'cold',
    ...overrides,
  };
}

describe('coerceIntuitionPayload', () => {
  it('returns null for non-object input', () => {
    expect(coerceIntuitionPayload(null)).toBeNull();
    expect(coerceIntuitionPayload(undefined)).toBeNull();
    expect(coerceIntuitionPayload(42)).toBeNull();
    expect(coerceIntuitionPayload('hi')).toBeNull();
    expect(coerceIntuitionPayload([])).toBeNull();
  });

  it('returns null when version is anything other than 1', () => {
    expect(coerceIntuitionPayload({ ...payload(), v: 2 })).toBeNull();
  });

  it('round-trips a valid payload including the trigger', () => {
    const out = coerceIntuitionPayload(payload({ trigger: 'stale' }));
    expect(out).toEqual(payload({ trigger: 'stale' }));
  });

  it('accepts the pivot trigger (decision-model gate reason)', () => {
    // Mirror of the Deno coercer's acceptance - the realtime echo path
    // coerces gate-fired payloads in the browser; a rejected trigger
    // here would drop the payload silently.
    const out = coerceIntuitionPayload(payload({ trigger: 'pivot' }));
    expect(out).not.toBeNull();
    expect(out!.trigger).toBe('pivot');
  });

  it('rejects an unknown trigger member', () => {
    expect(coerceIntuitionPayload(payload({ trigger: 'vibes' as IntuitionPayload['trigger'] }))).toBeNull();
  });

  it('rejects the synthesis-is-the-prompt regression shape', () => {
    expect(
      coerceIntuitionPayload(payload({ synthesis: 'You are the Subconsciousness of this chat.' }))
    ).toBeNull();
  });

  it('keeps only known drive names with non-empty strings', () => {
    // 'vibes' is deliberately not a DriveName - cast past the type to
    // prove the coercer drops unknown keys at runtime.
    const out = coerceIntuitionPayload(
      payload({
        drives: { curiosity: 'x', vibes: 'y', candor: '' } as unknown as IntuitionPayload['drives'],
      })
    );
    expect(out!.drives).toEqual({ curiosity: 'x' });
  });
});
