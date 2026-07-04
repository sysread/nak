/**
 * Unit coverage for the cohort-panel UI primitives. Pure functions
 * - no runes, no DOM, no reactive state - tested via plain vitest.
 *
 * The companion `src/components/CohortPanel.svelte` is the only
 * caller that wires these into Svelte reactivity; a port to another
 * framework would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import type {
  Message,
  SamskaraFireDiagnosticRow,
  SamskaraSubstrateDiagnosticRow,
} from '../src/lib/supabase';
import {
  assimilationStatus,
  buildUserRoundByMessageId,
  clusterFires,
  cohortCountLabel,
  fireVerdictLabel,
  fireVerdictStatusClass,
  formatRelative,
  formatValence,
  groupFiresByUserRound,
  isCollapsedView,
  resolutionLabel,
  resolutionStatusClass,
  sortFiresByScore,
  substrateStatusClass,
} from '../src/lib/ui/cohort-panel';

function makeFire(
  id: string,
  score: number,
  overrides: Partial<SamskaraFireDiagnosticRow> = {}
): SamskaraFireDiagnosticRow {
  return {
    id,
    score,
    firedAt: '2026-05-19T12:00:00.000Z',
    wasConfirmed: null,
    samskara: null,
    ...overrides,
  } as SamskaraFireDiagnosticRow;
}

function makeSubstrate(
  overrides: Partial<SamskaraSubstrateDiagnosticRow> = {}
): SamskaraSubstrateDiagnosticRow {
  return {
    situation: null,
    outcome: null,
    valence: null,
    embeddingModel: null,
    ...overrides,
  } as SamskaraSubstrateDiagnosticRow;
}

describe('sortFiresByScore', () => {
  it('orders fires highest-score-first', () => {
    const a = makeFire('a', 0.3);
    const b = makeFire('b', 0.9);
    const c = makeFire('c', 0.5);
    expect(sortFiresByScore([a, b, c]).map((f) => f.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [makeFire('a', 0.3), makeFire('b', 0.9)];
    sortFiresByScore(input);
    expect(input.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty input', () => {
    expect(sortFiresByScore([])).toEqual([]);
  });
});

describe('clusterFires', () => {
  it('buckets fires by cluster seq, representative-first by score', () => {
    const f1 = makeFire('f1', 0.9);
    const f2 = makeFire('f2', 0.6);
    const f3 = makeFire('f3', 0.4);
    const map = new Map([
      ['f1', { clusterSeq: 1, clusterSize: 2 }],
      ['f2', { clusterSeq: 1, clusterSize: 2 }],
      ['f3', { clusterSeq: 2, clusterSize: 1 }],
    ]);
    const out = clusterFires([f1, f2, f3], map);
    expect(out).toHaveLength(2);
    // Cluster 1 has the higher-scoring representative so it sorts
    // first overall.
    expect(out[0].seq).toBe(1);
    expect(out[0].representative.id).toBe('f1');
    expect(out[0].siblings.map((s) => s.id)).toEqual(['f2']);
    expect(out[1].seq).toBe(2);
    expect(out[1].representative.id).toBe('f3');
    expect(out[1].siblings).toEqual([]);
  });

  it('gives each unassigned fire a unique singleton bucket', () => {
    // The negative-fallback-seq rule. With `?? 0` the three
    // unassigned fires would silently collapse into one bucket
    // and the each-block keys would collide; with unique
    // descending negatives, every singleton stays distinct.
    const f1 = makeFire('f1', 0.9);
    const f2 = makeFire('f2', 0.6);
    const f3 = makeFire('f3', 0.4);
    const out = clusterFires([f1, f2, f3], new Map());
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.representative.id)).toEqual(['f1', 'f2', 'f3']);
    // All seqs are distinct (the collision protection).
    expect(new Set(out.map((c) => c.seq)).size).toBe(3);
    // All seqs are negative (the fallback path was taken).
    expect(out.every((c) => c.seq < 0)).toBe(true);
  });

  it('mixes assigned and unassigned fires without collapsing the singletons', () => {
    const f1 = makeFire('f1', 0.9);
    const f2 = makeFire('f2', 0.6);
    const f3 = makeFire('f3', 0.4);
    const f4 = makeFire('f4', 0.2);
    const map = new Map([
      ['f1', { clusterSeq: 7, clusterSize: 2 }],
      ['f2', { clusterSeq: 7, clusterSize: 2 }],
    ]);
    const out = clusterFires([f1, f2, f3, f4], map);
    expect(out).toHaveLength(3);
    expect(out[0].seq).toBe(7);
    expect(out[0].siblings.map((s) => s.id)).toEqual(['f2']);
    expect(out[1].representative.id).toBe('f3');
    expect(out[2].representative.id).toBe('f4');
  });

  it('returns an empty list for no fires', () => {
    expect(clusterFires([], new Map())).toEqual([]);
  });

  it('preserves the sorted order of siblings within a cluster', () => {
    // Siblings list comes from the same scored ordering; the
    // strongest non-rep should sit at the front of `siblings`.
    const f1 = makeFire('f1', 0.9);
    const f2 = makeFire('f2', 0.7);
    const f3 = makeFire('f3', 0.5);
    const map = new Map([
      ['f1', { clusterSeq: 1, clusterSize: 3 }],
      ['f2', { clusterSeq: 1, clusterSize: 3 }],
      ['f3', { clusterSeq: 1, clusterSize: 3 }],
    ]);
    const out = clusterFires([f1, f2, f3], map);
    expect(out[0].representative.id).toBe('f1');
    expect(out[0].siblings.map((s) => s.id)).toEqual(['f2', 'f3']);
  });
});

describe('isCollapsedView', () => {
  it('is true when clustering bucketed at least one pair of fires together', () => {
    const f1 = makeFire('f1', 0.9);
    const f2 = makeFire('f2', 0.6);
    const map = new Map([
      ['f1', { clusterSeq: 1, clusterSize: 2 }],
      ['f2', { clusterSeq: 1, clusterSize: 2 }],
    ]);
    const clusters = clusterFires([f1, f2], map);
    expect(isCollapsedView(clusters, [f1, f2])).toBe(true);
  });

  it('is false when every fire is its own singleton', () => {
    const f1 = makeFire('f1', 0.9);
    const f2 = makeFire('f2', 0.6);
    const clusters = clusterFires([f1, f2], new Map());
    expect(isCollapsedView(clusters, [f1, f2])).toBe(false);
  });

  it('is false for an empty cohort', () => {
    expect(isCollapsedView([], [])).toBe(false);
  });
});

describe('cohortCountLabel', () => {
  it('leads with the theme count in the grouped view', () => {
    expect(cohortCountLabel(2, 5, true)).toBe('2 themes from 5 predictions');
  });

  it('uses singular nouns at count one', () => {
    expect(cohortCountLabel(1, 1, true)).toBe('1 theme from 1 prediction');
  });

  it('shows only the fire count when not grouped', () => {
    expect(cohortCountLabel(2, 5, false)).toBe('5 predictions');
    expect(cohortCountLabel(0, 1, false)).toBe('1 prediction');
  });
});

describe('resolutionLabel', () => {
  it('returns "confirmed" for true', () => {
    expect(resolutionLabel(true)).toBe('confirmed');
  });

  it('returns "disconfirmed" for false', () => {
    expect(resolutionLabel(false)).toBe('disconfirmed');
  });

  it('returns "pending" for null (the unresolved state)', () => {
    expect(resolutionLabel(null)).toBe('pending');
  });
});

describe('resolutionStatusClass', () => {
  it('returns the CSS key parallel to resolutionLabel', () => {
    expect(resolutionStatusClass(true)).toBe('confirm');
    expect(resolutionStatusClass(false)).toBe('disconfirm');
    expect(resolutionStatusClass(null)).toBe('pending');
  });
});

describe('fireVerdictLabel', () => {
  it('keeps the soft miss distinct from a hard contradiction', () => {
    expect(fireVerdictLabel('held')).toBe('held');
    expect(fireVerdictLabel('contradicted')).toBe('contradicted');
    expect(fireVerdictLabel('not-borne-out')).toBe('not borne out');
    expect(fireVerdictLabel('not-engaged')).toBe('not engaged');
  });
  it('treats null (and any unknown) as pending', () => {
    expect(fireVerdictLabel(null)).toBe('pending');
    expect(fireVerdictLabel('garbage')).toBe('pending');
  });
});

describe('fireVerdictStatusClass', () => {
  it('maps each verdict to its colorway, soft miss separate from hard', () => {
    expect(fireVerdictStatusClass('held')).toBe('confirm');
    expect(fireVerdictStatusClass('contradicted')).toBe('disconfirm');
    expect(fireVerdictStatusClass('not-borne-out')).toBe('partial');
    expect(fireVerdictStatusClass('not-engaged')).toBe('neutral');
    expect(fireVerdictStatusClass(null)).toBe('pending');
  });
});

describe('assimilationStatus', () => {
  it('reports "pending assimilation" before the assimilator runs', () => {
    expect(assimilationStatus(makeSubstrate({ situation: null }))).toBe(
      'pending assimilation'
    );
  });

  it('reports "assimilated, pending embed" after assimilation but before embed', () => {
    expect(
      assimilationStatus(
        makeSubstrate({ situation: 'some text', embeddingModel: null })
      )
    ).toBe('assimilated, pending embed');
  });

  it('reports "assimilated + embedded" once the embed lands', () => {
    expect(
      assimilationStatus(
        makeSubstrate({ situation: 'some text', embeddingModel: 'venice-x' })
      )
    ).toBe('assimilated + embedded');
  });
});

describe('substrateStatusClass', () => {
  it('returns the CSS key parallel to assimilationStatus', () => {
    expect(substrateStatusClass(makeSubstrate({ situation: null }))).toBe(
      'pending'
    );
    expect(
      substrateStatusClass(
        makeSubstrate({ situation: 'some text', embeddingModel: null })
      )
    ).toBe('partial');
    expect(
      substrateStatusClass(
        makeSubstrate({ situation: 'some text', embeddingModel: 'venice-x' })
      )
    ).toBe('done');
  });
});

describe('formatRelative', () => {
  // Pinning `now` to a known instant so the unit boundaries are
  // testable without flake. Every assertion below feeds this
  // value via the second arg, mirroring the call shape the
  // component uses (where now defaults to Date.now()).
  const now = Date.parse('2026-05-19T12:00:00.000Z');

  it('returns "never" for null and undefined', () => {
    expect(formatRelative(null, now)).toBe('never');
    expect(formatRelative(undefined, now)).toBe('never');
  });

  it('returns the original string for unparseable input', () => {
    expect(formatRelative('not-a-date', now)).toBe('not-a-date');
  });

  it('renders seconds when under a minute old', () => {
    const iso = new Date(now - 5 * 1000).toISOString();
    expect(formatRelative(iso, now)).toBe('5s ago');
  });

  it('renders minutes when over a minute but under an hour', () => {
    const iso = new Date(now - 5 * 60 * 1000).toISOString();
    expect(formatRelative(iso, now)).toBe('5m ago');
  });

  it('renders hours when over an hour but under a day', () => {
    const iso = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(iso, now)).toBe('3h ago');
  });

  it('renders days when over a day but under a month', () => {
    const iso = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(iso, now)).toBe('5d ago');
  });

  it('renders months when over 30 days but under a year', () => {
    const iso = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(iso, now)).toBe('3mo ago');
  });

  it('renders years when over twelve months', () => {
    const iso = new Date(now - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(iso, now)).toBe('2y ago');
  });
});

describe('formatValence', () => {
  it('renders a hyphen for null', () => {
    expect(formatValence(null)).toBe('-');
  });

  it('forces a leading + on positive values', () => {
    expect(formatValence(0.42)).toBe('+0.42');
  });

  it('renders negatives with their native minus sign', () => {
    expect(formatValence(-0.3)).toBe('-0.30');
  });

  it('renders zero without a leading + (zero is not positive)', () => {
    expect(formatValence(0)).toBe('0.00');
  });

  it('clamps to two decimals', () => {
    expect(formatValence(0.123456)).toBe('+0.12');
    expect(formatValence(-0.987)).toBe('-0.99');
  });
});

describe('buildUserRoundByMessageId', () => {
  function row(id: string, role: Message['role']): Message {
    return {
      id,
      thread_id: 't1',
      role,
      content: '',
      created_at: '2024-01-01T00:00:00Z',
    } as Message;
  }

  it('assigns 1..N to user messages in transcript order, skipping other roles', () => {
    const map = buildUserRoundByMessageId([
      row('u1', 'user'),
      row('a1', 'assistant'),
      row('r1', 'tool'),
      row('u2', 'user'),
      row('a2', 'assistant'),
      row('u3', 'user'),
    ]);
    expect([...map.entries()]).toEqual([
      ['u1', 1],
      ['u2', 2],
      ['u3', 3],
    ]);
  });

  it('returns an empty map for a transcript with no user rows', () => {
    expect(buildUserRoundByMessageId([row('a1', 'assistant')]).size).toBe(0);
    expect(buildUserRoundByMessageId([]).size).toBe(0);
  });
});

describe('groupFiresByUserRound', () => {
  it('buckets fires by their persisted round, preserving input order within a bucket', () => {
    const f1 = makeFire('f1', 0.9, { userRound: 1 });
    const f2 = makeFire('f2', 0.5, { userRound: 2 });
    const f3 = makeFire('f3', 0.7, { userRound: 1 });
    const map = groupFiresByUserRound([f1, f2, f3]);
    expect(map.get(1)).toEqual([f1, f3]);
    expect(map.get(2)).toEqual([f2]);
  });

  it('drops legacy rows with a null userRound instead of anchoring them arbitrarily', () => {
    const legacy = makeFire('f1', 0.9, { userRound: null });
    const map = groupFiresByUserRound([legacy]);
    expect(map.size).toBe(0);
  });
});
