/**
 * Coverage for the intents-inspector UI primitives. Pure functions, no
 * DOM / no Svelte. These pin the inspector's honesty rules: a free-form
 * intent never shows a score, an unscored targeted intent reads as "too
 * new", and the target label states the agenda plainly.
 */
import { describe, it, expect } from 'vitest';
import {
  groupByStatus,
  reformedIds,
  efficacyView,
  targetLabel,
  activeHeadline,
  formatRelative,
  type IntentRow,
} from '../src/lib/ui/intents-inspector';

function row(over: Partial<IntentRow> = {}): IntentRow {
  return {
    id: 'i1',
    statement: 'help them name a contrary view',
    rationale: null,
    status: 'active',
    target_kind: 'none',
    target_ref: null,
    target_direction: null,
    efficacy: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    last_minted_at: null,
    ...over,
  };
}

describe('groupByStatus', () => {
  it('partitions and sorts each group most-recent first', () => {
    // Distinct statements so the retired row is not read as a twin of a
    // live one (see the suppression test below).
    const rows = [
      row({ id: 'a', status: 'active', statement: 'stmt a', updated_at: '2026-06-01T00:00:00Z' }),
      row({ id: 'b', status: 'active', statement: 'stmt b', updated_at: '2026-06-03T00:00:00Z' }),
      row({ id: 'c', status: 'dormant', statement: 'stmt c' }),
      row({ id: 'd', status: 'retired', statement: 'stmt d' }),
    ];
    const g = groupByStatus(rows);
    expect(g.active.map((r) => r.id)).toEqual(['b', 'a']); // freshest first
    expect(g.dormant.map((r) => r.id)).toEqual(['c']);
    expect(g.retired.map((r) => r.id)).toEqual(['d']);
  });

  it('hides a retired twin of a live statement so it does not show twice', () => {
    // A goal let go earlier and since re-formed: the retired row carries
    // the same statement as a live one, so it is dropped from "Let go"
    // (the active card is flagged re-formed instead). A genuinely
    // distinct retired intent still shows.
    const rows = [
      row({ id: 'a', status: 'active', statement: 'help them test it' }),
      row({ id: 'b', status: 'retired', statement: 'Help Them  Test It' }), // same after normalize
      row({ id: 'c', status: 'retired', statement: 'something else' }),
    ];
    const g = groupByStatus(rows);
    expect(g.active.map((r) => r.id)).toEqual(['a']);
    expect(g.retired.map((r) => r.id)).toEqual(['c']); // 'b' suppressed
  });
});

describe('reformedIds', () => {
  it('flags a live intent whose statement also appears retired', () => {
    const rows = [
      row({ id: 'a', status: 'active', statement: 'help them test it' }),
      row({ id: 'b', status: 'retired', statement: 'help them test it' }),
      row({ id: 'c', status: 'active', statement: 'a fresh goal' }),
    ];
    const ids = reformedIds(rows);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('c')).toBe(false);
    expect(ids.has('b')).toBe(false); // the retired row itself is not "re-formed"
  });
});

describe('efficacyView - the honesty rules', () => {
  it('a free-form intent is never scored', () => {
    const v = efficacyView(row({ target_kind: 'none', efficacy: 0.9 }));
    // even if a stray efficacy were present, free-form reports freeform
    expect(v.state).toBe('freeform');
    expect(v.label).toBe('open-ended');
  });

  it('a targeted intent with no posterior reads as too-new, not a verdict', () => {
    const v = efficacyView(row({ target_kind: 'bias', target_ref: 'confirmation_bias', efficacy: null }));
    expect(v.state).toBe('unscored');
    expect(v.hint).toMatch(/not enough/i);
  });

  it('buckets a scored target into landing / mixed / struggling', () => {
    const base = { target_kind: 'bias' as const, target_ref: 'confirmation_bias' };
    expect(efficacyView(row({ ...base, efficacy: 0.7 })).state).toBe('landing');
    expect(efficacyView(row({ ...base, efficacy: 0.5 })).state).toBe('mixed');
    expect(efficacyView(row({ ...base, efficacy: 0.2 })).state).toBe('struggling');
  });
});

describe('targetLabel - states the agenda plainly', () => {
  it('names a bias target from the catalog with the direction', () => {
    expect(
      targetLabel(row({ target_kind: 'bias', target_ref: 'confirmation_bias', target_direction: 'reduce' })),
    ).toBe('easing confirmation bias');
  });

  it('describes a samskara target without leaking the raw prediction', () => {
    expect(
      targetLabel(row({ target_kind: 'samskara', target_ref: 'some-uuid', target_direction: 'reinforce' })),
    ).toBe('leaning into a predicted pattern');
  });

  it('says no target for free-form', () => {
    expect(targetLabel(row({ target_kind: 'none' }))).toBe('no specific target');
  });

  it('degrades gracefully for an unknown bias key', () => {
    expect(
      targetLabel(row({ target_kind: 'bias', target_ref: 'not_a_catalog_key', target_direction: 'reduce' })),
    ).toBe('easing a cognitive pattern');
  });
});

describe('activeHeadline', () => {
  it('pluralizes', () => {
    expect(activeHeadline(0)).toMatch(/no intentions/i);
    expect(activeHeadline(1)).toMatch(/1 intention\b/);
    expect(activeHeadline(3)).toMatch(/3 intentions/);
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-06-20T00:00:00Z');
  it('reads coarsely', () => {
    expect(formatRelative('2026-06-20T00:00:00Z', now)).toBe('today');
    expect(formatRelative('2026-06-19T00:00:00Z', now)).toBe('yesterday');
    expect(formatRelative('2026-06-17T00:00:00Z', now)).toBe('3 days ago');
    expect(formatRelative('2026-06-10T00:00:00Z', now)).toBe('last week');
  });
  it('returns empty for garbage', () => {
    expect(formatRelative('not-a-date', now)).toBe('');
  });
});
