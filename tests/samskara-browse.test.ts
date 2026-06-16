/**
 * Unit coverage for the Samskara browse/health UI primitives. Pure
 * functions, no mount - drives the decision logic the diagnostics tab's
 * components delegate to.
 */
import { describe, it, expect } from 'vitest';
import {
  collapseSimilar,
  severityFor,
  compoundRegenStatus,
  matchSummary,
  worstSeverity,
  relativeTime,
  formatValence,
  emptyMessage,
  HEALTH_THRESHOLDS,
  groupProvenance,
  verdictBreakdown,
  tier2CandidateLabel,
  samskaraCountPhrase,
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

describe('severityFor', () => {
  it('classifies against a [warn, alarm] pair', () => {
    expect(severityFor(0, HEALTH_THRESHOLDS.orphanFires)).toBe('ok');
    expect(severityFor(1, HEALTH_THRESHOLDS.orphanFires)).toBe('warn');
    expect(severityFor(5, HEALTH_THRESHOLDS.orphanFires)).toBe('alarm');
    expect(severityFor(49, HEALTH_THRESHOLDS.pendingAssimilate)).toBe('ok');
    expect(severityFor(50, HEALTH_THRESHOLDS.pendingAssimilate)).toBe('warn');
    expect(severityFor(500, HEALTH_THRESHOLDS.pendingAssimilate)).toBe('alarm');
  });
});

describe('compoundRegenStatus', () => {
  // threshold = max(3, ceil(5 * log10(total + 10))). At total=152 the bar
  // is ceil(5 * log10(162)) = ceil(11.04) = 12; alarm at 2x = 24.
  it('severity tracks the regen backlog, not the summary age', () => {
    expect(compoundRegenStatus(152, 152, true).sev).toBe('ok'); // 0 new
    expect(compoundRegenStatus(152, 145, true).sev).toBe('ok'); // 7 < 12
    expect(compoundRegenStatus(152, 140, true).sev).toBe('warn'); // 12 >= 12
    expect(compoundRegenStatus(152, 128, true).sev).toBe('alarm'); // 24 >= 24
  });
  it('exposes the delta and threshold for the readout', () => {
    expect(compoundRegenStatus(152, 145, true)).toMatchObject({ delta: 7, threshold: 12 });
  });
  it('floors the threshold at 3 for a small corpus', () => {
    // ceil(5 * log10(13)) = ceil(5.57) = 6, so the floor doesn't bind
    // here; a near-empty corpus (total=0 -> ceil(5*log10(10))=5) is still
    // above 3, so the floor only matters as a guard, never a false alarm.
    expect(compoundRegenStatus(3, 0, true).threshold).toBeGreaterThanOrEqual(3);
  });
  it('treats a missing summary as warn when any samskaras exist, else ok', () => {
    expect(compoundRegenStatus(5, 0, false).sev).toBe('warn');
    expect(compoundRegenStatus(0, 0, false).sev).toBe('ok');
  });
  it('clamps a negative delta to ok (count_at_regen above current count)', () => {
    // A regen stamped a higher count than the live total (e.g. reaping
    // dropped rows after the stamp) must not read as a backlog.
    expect(compoundRegenStatus(140, 152, true).sev).toBe('ok');
  });
});

describe('matchSummary', () => {
  it('reports shown / total and how many were folded', () => {
    expect(matchSummary(47, 120)).toBe('Showing 47 of 120 - 73 folded as similar');
    expect(matchSummary(120, 120)).toBe('Showing 120 of 120 - 0 folded as similar');
  });
});

describe('worstSeverity', () => {
  it('alarm dominates warn dominates ok', () => {
    expect(worstSeverity(['ok', 'warn', 'alarm'])).toBe('alarm');
    expect(worstSeverity(['ok', 'warn'])).toBe('warn');
    expect(worstSeverity(['ok', 'ok'])).toBe('ok');
    expect(worstSeverity([])).toBe('ok');
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

describe('verdictBreakdown', () => {
  it('emits the three verdicts in the panel stack order', () => {
    const out = verdictBreakdown({ held: 5, contradicted: 2, notEngaged: 7 });
    expect(out.map((v) => v.label)).toEqual(['held', 'contradicted', 'not-engaged']);
    expect(out.map((v) => v.count)).toEqual([5, 2, 7]);
  });
});

describe('tier2CandidateLabel', () => {
  it('reports none when nothing is offerable', () => {
    expect(tier2CandidateLabel(0)).toBe('none available');
    // Defensive: the RPC never returns negatives, but the floor holds.
    expect(tier2CandidateLabel(-1)).toBe('none available');
  });
  it('reports the member count, pluralizing', () => {
    // The minter's floor is 3, so 1 is the defensive-singular path.
    expect(tier2CandidateLabel(1)).toBe('available (1 member)');
    expect(tier2CandidateLabel(4)).toBe('available (4 members)');
  });
});

describe('samskaraCountPhrase', () => {
  it('pluralizes the coverage caption', () => {
    expect(samskaraCountPhrase(0)).toBe('0 samskaras');
    expect(samskaraCountPhrase(1)).toBe('1 samskara');
    expect(samskaraCountPhrase(14)).toBe('14 samskaras');
  });
});
