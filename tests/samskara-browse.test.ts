/**
 * Unit coverage for the Samskara browse/detail UI primitives. Pure
 * functions, no mount - drives the decision logic the Corpus list and
 * detail pane delegate to. The Health panel's severity toolkit is
 * covered in tests/samskara-health.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  collapseSimilar,
  matchSummary,
  relativeTime,
  formatValence,
  emptyMessage,
  groupProvenance,
  verdictCountList,
  type CollapsedRow,
} from '../src/lib/ui/samskara-browse';
import type { SamskaraCorpusRow, SamskaraProvenanceRow } from '../src/lib/supabase';

function row(id: string): SamskaraCorpusRow {
  return {
    id,
    tier: 1,
    prediction: `pred ${id}`,
    innerVoice: null,
    valence: 0,
    confidence: 0.5,
    health: 1,
    fireCount: 0,
    confirmCount: 0,
    disconfirmCount: 0,
    lastFiredAt: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('collapseSimilar', () => {
  it('keeps only the first row of each cluster and counts the rest', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')];
    const clusters = new Map([
      ['a', { seq: 1, size: 3 }],
      ['b', { seq: 1, size: 3 }],
      ['c', { seq: 1, size: 3 }],
      ['d', { seq: 2, size: 1 }],
    ]);
    const out = collapseSimilar(rows, clusters);
    expect(out.map((c: CollapsedRow) => c.row.id)).toEqual(['a', 'd']);
    expect(out[0].similarCount).toBe(2); // a represents 3, hides 2
    expect(out[1].similarCount).toBe(0);
  });

  it('keeps unclustered rows as their own singletons', () => {
    const rows = [row('a'), row('b')];
    const out = collapseSimilar(rows, new Map());
    expect(out.map((c) => c.row.id)).toEqual(['a', 'b']);
    expect(out.every((c) => c.similarCount === 0)).toBe(true);
  });

  it('respects list order when picking the representative', () => {
    // b appears before a; b becomes the representative of seq 1.
    const rows = [row('b'), row('a')];
    const clusters = new Map([
      ['a', { seq: 1, size: 2 }],
      ['b', { seq: 1, size: 2 }],
    ]);
    const out = collapseSimilar(rows, clusters);
    expect(out.map((c) => c.row.id)).toEqual(['b']);
    expect(out[0].similarCount).toBe(1);
  });
});

describe('matchSummary', () => {
  it('reports shown / total and how many were folded', () => {
    expect(matchSummary(47, 120)).toBe('Showing 47 of 120 - 73 folded as similar');
    expect(matchSummary(120, 120)).toBe('Showing 120 of 120 - 0 folded as similar');
  });
});

describe('groupProvenance', () => {
  const row = (
    kind: SamskaraProvenanceRow['kind'],
    refId: string,
    weight = 1,
  ): SamskaraProvenanceRow => ({ kind, refId, weight, label: refId, refTier: null });

  it('groups mixed provenance into display order, one section per kind', () => {
    // Intentionally interleaved + association weight above substrate, to
    // prove ordering comes from the kind order, not row order or weight.
    const groups = groupProvenance([
      row('association', 'a1', 5),
      row('substrate', 's1'),
      row('association', 'a2', 3),
      row('substrate', 's2'),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['substrate', 'association']);
    expect(groups[0].heading).toBe('Formed from (substrate)');
    expect(groups[1].heading).toBe('Related observations');
    expect(groups[0].rows.map((r) => r.refId)).toEqual(['s1', 's2']);
    expect(groups[1].rows.map((r) => r.refId)).toEqual(['a1', 'a2']);
  });

  it('drops empty kinds: a single-kind samskara yields exactly one group', () => {
    const groups = groupProvenance([row('samskara', 'c1'), row('samskara', 'c2')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('samskara');
    expect(groups[0].heading).toBe('Compounded from (tier-1 children)');
  });

  it('returns no groups for empty provenance', () => {
    expect(groupProvenance([])).toEqual([]);
  });
});

describe('relativeTime / formatValence / emptyMessage', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');
  it('formats relative time compactly', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime('2026-06-10T11:59:30Z', now)).toBe('30s ago');
    expect(relativeTime('2026-06-10T11:30:00Z', now)).toBe('30m ago');
    expect(relativeTime('2026-06-08T12:00:00Z', now)).toBe('2d ago');
  });
  it('formats valence with explicit sign', () => {
    expect(formatValence(null)).toBe('n/a');
    expect(formatValence(0.34)).toBe('+0.3');
    expect(formatValence(-0.34)).toBe('-0.3');
    expect(formatValence(0)).toBe('0.0');
  });
  it('distinguishes empty-corpus from no-match messaging', () => {
    expect(emptyMessage('')).toMatch(/form as you chat/);
    expect(emptyMessage('foo')).toMatch(/No matching/);
  });
});

describe('verdictCountList', () => {
  it('emits the four verdicts plus a trailing pending, in order', () => {
    const out = verdictCountList({
      held: 5,
      contradicted: 2,
      notBorneOut: 3,
      notEngaged: 7,
      pending: 11,
    });
    expect(out.map((v) => v.label)).toEqual([
      'held',
      'contradicted',
      'not-borne-out',
      'not-engaged',
      'pending',
    ]);
    expect(out.map((v) => v.count)).toEqual([5, 2, 3, 7, 11]);
  });
});

