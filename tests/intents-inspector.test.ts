/**
 * Coverage for the intents-inspector UI primitives. Pure functions, no
 * DOM / no Svelte. These pin the inspector's honesty rules: a free-form
 * intent never shows a score, an unscored targeted intent reads as "too
 * new", and the target label states the agenda plainly.
 */
import { describe, it, expect } from 'vitest';
import {
  groupByStatus,
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
    const rows = [
      row({ id: 'a', status: 'active', updated_at: '2026-06-01T00:00:00Z' }),
      row({ id: 'b', status: 'active', updated_at: '2026-06-03T00:00:00Z' }),
      row({ id: 'c', status: 'dormant' }),
      row({ id: 'd', status: 'retired' }),
    ];
    const g = groupByStatus(rows);
    expect(g.active.map((r) => r.id)).toEqual(['b', 'a']); // freshest first
    expect(g.dormant.map((r) => r.id)).toEqual(['c']);
    expect(g.retired.map((r) => r.id)).toEqual(['d']);
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
