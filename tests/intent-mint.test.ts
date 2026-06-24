/**
 * Coverage for the minting proposal processor - the trusted boundary
 * between the fallible minter agent and the intents table. Pure
 * functions, no DB / no LLM / no Deno globals.
 *
 * These assertions pin the mechanical invariants the prompt is NOT
 * trusted to hold: well-formed target bindings (a half-specified
 * target must never become a free-form intent that looks scored - the
 * firewall-leak shape), exact-after-normalization dedup, and the
 * active-set cap trimming creates (never existing intents) from the
 * lowest-priority end.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeStatement,
  isValidTarget,
  coerceProposedIntent,
  processMintProposals,
  ACTIVE_INTENT_CAP,
  type ExistingIntent,
} from '../supabase/functions/_shared/intent-mint';

describe('normalizeStatement', () => {
  it('trims, collapses whitespace, and lowercases', () => {
    expect(normalizeStatement('  Help   Them  Test ')).toBe('help them test');
  });
});

describe('isValidTarget', () => {
  it('accepts free-form with no ref or direction', () => {
    expect(isValidTarget({ kind: 'none', ref: null, direction: null })).toBe(true);
  });
  it('rejects free-form that carries a ref or direction', () => {
    expect(isValidTarget({ kind: 'none', ref: 'x', direction: null })).toBe(false);
    expect(isValidTarget({ kind: 'none', ref: null, direction: 'reduce' })).toBe(false);
  });
  it('requires both ref and direction for a measurable target', () => {
    expect(isValidTarget({ kind: 'bias', ref: 'confirmation_bias', direction: 'reduce' })).toBe(true);
    expect(isValidTarget({ kind: 'bias', ref: 'confirmation_bias', direction: null })).toBe(false);
    expect(isValidTarget({ kind: 'samskara', ref: null, direction: 'reduce' })).toBe(false);
  });
});

describe('coerceProposedIntent', () => {
  it('drops non-objects and empty statements', () => {
    expect(coerceProposedIntent(null)).toBeNull();
    expect(coerceProposedIntent('nope')).toBeNull();
    expect(coerceProposedIntent({ statement: '   ' })).toBeNull();
  });

  it('defaults a missing target to free-form', () => {
    const out = coerceProposedIntent({ statement: 'help them slow down' });
    expect(out).not.toBeNull();
    expect(out!.target).toEqual({ kind: 'none', ref: null, direction: null });
    expect(out!.rationale).toBeNull();
  });

  it('keeps a coherent measurable target', () => {
    const out = coerceProposedIntent({
      statement: 'help them test beliefs',
      rationale: 'they seek confirmation',
      target: { kind: 'bias', ref: 'confirmation_bias', direction: 'reduce' },
    });
    expect(out!.target).toEqual({
      kind: 'bias',
      ref: 'confirmation_bias',
      direction: 'reduce',
    });
    expect(out!.rationale).toBe('they seek confirmation');
  });

  it('drops a half-specified target rather than downgrading it to free-form', () => {
    // The firewall-leak case: a target_kind='bias' with no direction
    // would otherwise look scored but have no metric. Reject it.
    expect(
      coerceProposedIntent({
        statement: 'x',
        target: { kind: 'bias', ref: 'confirmation_bias' },
      }),
    ).toBeNull();
  });

  it('drops an unrecognized target kind rather than silently downgrading', () => {
    expect(
      coerceProposedIntent({ statement: 'x', target: { kind: 'mood' } }),
    ).toBeNull();
  });
});

describe('processMintProposals', () => {
  const ex = (id: string, statement: string, status: ExistingIntent['status'] = 'active'): ExistingIntent => ({
    id,
    statement,
    status,
  });

  it('coerces creates and drops invalid ones', () => {
    const plan = processMintProposals({
      rawCreates: [
        { statement: 'good one' },
        { statement: '' }, // dropped
        42, // dropped
      ],
      rawRetires: [],
      existing: [],
    });
    expect(plan.toCreate.map((c) => c.statement)).toEqual(['good one']);
  });

  it('validates retires against existing ids and drops unknowns', () => {
    const plan = processMintProposals({
      rawCreates: [],
      rawRetires: ['real-1', 'ghost', 'real-1'],
      existing: [ex('real-1', 'a')],
    });
    expect(plan.toRetire).toEqual(['real-1']); // unknown + dup dropped
  });

  it('dedups a create against an existing non-retired statement', () => {
    const plan = processMintProposals({
      rawCreates: [{ statement: 'Help Them  Test' }], // same after normalize
      rawRetires: [],
      existing: [ex('1', 'help them test')],
    });
    expect(plan.toCreate).toEqual([]);
  });

  it('allows re-minting a statement that belongs to a retired (or now-retired) intent', () => {
    // The pattern came back: a retired intent's statement is free to
    // re-form. Same for one being retired in this very batch.
    const plan = processMintProposals({
      rawCreates: [{ statement: 'help them test' }],
      rawRetires: ['1'],
      existing: [ex('1', 'help them test', 'active')],
    });
    expect(plan.toRetire).toEqual(['1']);
    expect(plan.toCreate.map((c) => c.statement)).toEqual(['help them test']);
  });

  it('dedups duplicate creates within one batch', () => {
    const plan = processMintProposals({
      rawCreates: [{ statement: 'one goal' }, { statement: 'one goal' }],
      rawRetires: [],
      existing: [],
    });
    expect(plan.toCreate.length).toBe(1);
  });

  it('enforces the cap, trimming creates from the low-priority end', () => {
    // 2 existing active + cap 3 => room for 1; the agent's first
    // proposal survives, the rest are dropped and counted.
    const plan = processMintProposals({
      rawCreates: [{ statement: 'first' }, { statement: 'second' }, { statement: 'third' }],
      rawRetires: [],
      existing: [ex('1', 'a'), ex('2', 'b')],
      cap: 3,
    });
    expect(plan.toCreate.map((c) => c.statement)).toEqual(['first']);
    expect(plan.droppedForCap).toBe(2);
  });

  it('retiring an existing active intent frees a cap slot for a create', () => {
    const plan = processMintProposals({
      rawCreates: [{ statement: 'fresh' }],
      rawRetires: ['1'],
      existing: [ex('1', 'old'), ex('2', 'b')],
      cap: 2,
    });
    // 2 active - 1 retired = 1 surviving; cap 2 => room for 1 create.
    expect(plan.toCreate.map((c) => c.statement)).toEqual(['fresh']);
    expect(plan.droppedForCap).toBe(0);
  });

  it('does not count dormant intents against the active cap', () => {
    const plan = processMintProposals({
      rawCreates: [{ statement: 'a' }, { statement: 'b' }],
      rawRetires: [],
      existing: [ex('1', 'x', 'dormant'), ex('2', 'y', 'dormant')],
      cap: 2,
    });
    // dormant rows are not active, so both creates fit.
    expect(plan.toCreate.length).toBe(2);
  });

  it('defaults to ACTIVE_INTENT_CAP when no cap is passed', () => {
    const creates = Array.from({ length: ACTIVE_INTENT_CAP + 2 }, (_, i) => ({
      statement: `goal ${i}`,
    }));
    const plan = processMintProposals({ rawCreates: creates, rawRetires: [], existing: [] });
    expect(plan.toCreate.length).toBe(ACTIVE_INTENT_CAP);
    expect(plan.droppedForCap).toBe(2);
  });
});
