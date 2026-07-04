/**
 * Coverage for the drawer's thread-bucket list surgery
 * (src/lib/ui/thread-buckets.ts). Pure functions - plain vitest, no
 * mount. Ordering assertions all follow the shared server contract:
 * (updated_at desc, id desc).
 */
import { describe, it, expect } from 'vitest';
import type { Thread } from '../src/lib/supabase';
import {
  bucketFor,
  insertByUpdatedAtDesc,
  mergeByUpdatedAtDesc,
  mergeServerThreadList,
  sortsAheadOfCursor,
} from '../src/lib/ui/thread-buckets';

const CUTOFF = '2024-06-01T00:00:00Z';

function thread(over: Partial<Thread>): Thread {
  return {
    id: 't1',
    title: 'T',
    archived: false,
    updated_at: '2024-06-02T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    intuition_payload: null,
    context_recall_payload: null,
    ...over,
  } as Thread;
}

describe('bucketFor', () => {
  it('classifies drafts first, archived second, then splits on the cutoff', () => {
    expect(bucketFor(thread({ isDraft: true }), CUTOFF)).toBe('draft');
    // Draft wins even over archived - internal placement is the
    // drafts array regardless of other flags.
    expect(bucketFor(thread({ isDraft: true, archived: true }), CUTOFF)).toBe('draft');
    expect(bucketFor(thread({ archived: true }), CUTOFF)).toBe('archived');
    expect(bucketFor(thread({ updated_at: '2024-06-02T00:00:00Z' }), CUTOFF)).toBe('recent');
    expect(bucketFor(thread({ updated_at: '2024-05-01T00:00:00Z' }), CUTOFF)).toBe('older');
  });

  it('counts a thread exactly at the cutoff as recent (>= boundary)', () => {
    expect(bucketFor(thread({ updated_at: CUTOFF }), CUTOFF)).toBe('recent');
  });
});

describe('sortsAheadOfCursor', () => {
  const cursor = { updated_at: '2024-06-01T00:00:00Z', id: 'mmm' };

  it('is true for a strictly newer updated_at, false for older', () => {
    expect(sortsAheadOfCursor(thread({ updated_at: '2024-06-02T00:00:00Z' }), cursor)).toBe(true);
    expect(sortsAheadOfCursor(thread({ updated_at: '2024-05-31T00:00:00Z' }), cursor)).toBe(false);
  });

  it('breaks updated_at ties by id desc', () => {
    expect(
      sortsAheadOfCursor(thread({ updated_at: cursor.updated_at, id: 'zzz' }), cursor)
    ).toBe(true);
    expect(
      sortsAheadOfCursor(thread({ updated_at: cursor.updated_at, id: 'aaa' }), cursor)
    ).toBe(false);
    // The cursor row itself does not sort ahead of itself.
    expect(
      sortsAheadOfCursor(thread({ updated_at: cursor.updated_at, id: 'mmm' }), cursor)
    ).toBe(false);
  });
});

describe('insertByUpdatedAtDesc', () => {
  const older = thread({ id: 'old', updated_at: '2024-06-01T00:00:00Z' });
  const newer = thread({ id: 'new', updated_at: '2024-06-03T00:00:00Z' });

  it('inserts at the front, middle, and back by updated_at desc', () => {
    const mid = thread({ id: 'mid', updated_at: '2024-06-02T00:00:00Z' });
    expect(insertByUpdatedAtDesc([older], newer).map((t) => t.id)).toEqual(['new', 'old']);
    expect(insertByUpdatedAtDesc([newer, older], mid).map((t) => t.id)).toEqual([
      'new',
      'mid',
      'old',
    ]);
    expect(insertByUpdatedAtDesc([newer], older).map((t) => t.id)).toEqual(['new', 'old']);
  });

  it('places an equal-timestamp row after the existing run (stable, no reorder)', () => {
    const twin = thread({ id: 'twin', updated_at: older.updated_at });
    expect(insertByUpdatedAtDesc([older], twin).map((t) => t.id)).toEqual(['old', 'twin']);
  });

  it('returns a fresh array and leaves the input untouched', () => {
    const arr = [older];
    const out = insertByUpdatedAtDesc(arr, newer);
    expect(out).not.toBe(arr);
    expect(arr).toEqual([older]);
  });
});

describe('mergeByUpdatedAtDesc', () => {
  const a1 = thread({ id: 'a1', updated_at: '2024-06-04T00:00:00Z' });
  const a2 = thread({ id: 'a2', updated_at: '2024-06-02T00:00:00Z' });
  const b1 = thread({ id: 'b1', updated_at: '2024-06-03T00:00:00Z' });
  const b2 = thread({ id: 'b2', updated_at: '2024-06-01T00:00:00Z' });

  it('interleaves two sorted-desc lists into one sorted-desc list', () => {
    expect(mergeByUpdatedAtDesc([a1, a2], [b1, b2]).map((t) => t.id)).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
    ]);
  });

  it('dedupes by id, keeping the first-encountered copy', () => {
    const b1dup = thread({ id: 'a1', updated_at: a1.updated_at, title: 'stale copy' });
    const out = mergeByUpdatedAtDesc([a1, a2], [b1dup, b2]);
    expect(out.map((t) => t.id)).toEqual(['a1', 'a2', 'b2']);
    expect(out[0].title).toBe('T');
  });

  it('handles an empty side on either end', () => {
    expect(mergeByUpdatedAtDesc([], [b1])).toEqual([b1]);
    expect(mergeByUpdatedAtDesc([a1], [])).toEqual([a1]);
    expect(mergeByUpdatedAtDesc([], [])).toEqual([]);
  });
});

describe('mergeServerThreadList', () => {
  // A minimal VALID context-recall payload (v2 shape) - the freshness
  // merge only keeps a side when it coerces cleanly, so the fixture
  // has to pass coerceContextRecallPayload.
  function crPayload(at: number): unknown {
    return {
      v: 2,
      note: 'remembered something',
      citations: [],
      computed_at_round: 1,
      computed_at_band: null,
      computed_at_column: null,
      computed_at_at: at,
      trigger: 'cold',
    };
  }

  it('passes rows through unchanged when nothing is loaded for them', () => {
    const row = thread({ id: 'srv' });
    expect(mergeServerThreadList([row], [])).toEqual([row]);
  });

  it('keeps a fresher in-memory payload over a stale server snapshot', () => {
    const inMemory = thread({ id: 'x', context_recall_payload: crPayload(2000) });
    const serverRow = thread({
      id: 'x',
      title: 'server title',
      context_recall_payload: crPayload(1000),
    });
    const [merged] = mergeServerThreadList([serverRow], [inMemory]);
    // Server row wins on every other field; only the payload merge
    // prefers the fresher side.
    expect(merged.title).toBe('server title');
    expect(merged.context_recall_payload).toEqual(crPayload(2000));
  });

  it('keeps the in-memory payload when the server echo carries null (failed cache write)', () => {
    const inMemory = thread({ id: 'x', context_recall_payload: crPayload(2000) });
    const serverRow = thread({ id: 'x', context_recall_payload: null });
    const [merged] = mergeServerThreadList([serverRow], [inMemory]);
    expect(merged.context_recall_payload).toEqual(crPayload(2000));
  });

  it('accepts the server payload when it is at least as fresh', () => {
    const inMemory = thread({ id: 'x', context_recall_payload: crPayload(1000) });
    const serverRow = thread({ id: 'x', context_recall_payload: crPayload(3000) });
    const [merged] = mergeServerThreadList([serverRow], [inMemory]);
    expect(merged.context_recall_payload).toEqual(crPayload(3000));
  });
});
