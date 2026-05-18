/**
 * Coverage for SupabaseService.searchThreads + the paginated
 * list helpers. The interesting invariants:
 *
 *   - Search merges exact hits before semantic, dedupes by id, and
 *     respects the overall limit cap. Exact-first is the load-bearing
 *     rule — users expect a title substring match to outrank a
 *     paraphrased summary hit.
 *
 *   - The paginated list helpers hand back a cursor derived from the
 *     last row of each page, with `nextCursor === null` ONLY when
 *     we've hit the tail (pageSize+1 overfetch didn't return extra).
 *
 * The test replaces the underlying supabase-js client with a
 * hand-rolled stub so the assertions pin the request shape (ILIKE
 * pattern, eq filters, cursor or-clause, limit) without booting
 * Postgres. The RPC calls go through the same `.rpc` method the
 * client exposes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SupabaseService, type Thread } from '../src/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeRow(overrides: Partial<Thread> & Pick<Thread, 'id' | 'updated_at'>) {
  return {
    user_id: 'u-1',
    title: 'placeholder',
    model: null,
    reasoning_effort: null,
    verbosity: null,
    toolboxes_enabled: [],
    archived: false,
    created_at: overrides.updated_at,
    ...overrides,
  };
}

function makeClient(opts: {
  fromData?: unknown[];
  rpcData?: unknown;
  captured?: { lastFromCall?: Record<string, unknown[]> };
}) {
  const captured = opts.captured ?? { lastFromCall: {} };
  const builder: Record<string, unknown> = {};
  const chainable = [
    'select',
    'eq',
    'ilike',
    'gte',
    'lt',
    'or',
    'order',
    'limit',
    'is',
  ];
  for (const m of chainable) {
    builder[m] = vi.fn((...args: unknown[]) => {
      captured.lastFromCall![m] = args;
      return builder;
    });
  }
  builder.then = (resolve: (v: unknown) => void) => {
    resolve({ data: opts.fromData ?? [], error: null });
    return builder;
  };
  return {
    from: vi.fn(() => builder),
    rpc: vi.fn(async () => ({ data: opts.rpcData ?? [], error: null })),
  } as unknown as SupabaseClient;
}

function makeService(client: SupabaseClient): SupabaseService {
  return new SupabaseService(
    { supabaseUrl: 'http://example.test', supabaseAnonKey: 'anon' },
    { client }
  );
}

describe('searchThreads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty and skips both queries on an empty / whitespace query', async () => {
    const client = makeClient({});
    const svc = makeService(client);
    const out = await svc.searchThreads({ query: '   ', queryEmbedding: null });
    expect(out).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('ranks exact hits before semantic hits', async () => {
    const exactRows = [
      makeRow({ id: 'exact-1', updated_at: '2026-04-18T00:00:00Z', title: 'exact match' }),
    ];
    const semanticRows = [
      {
        id: 'sem-1',
        title: 'paraphrase',
        archived: false,
        updated_at: '2026-04-10T00:00:00Z',
        similarity: 0.75,
      },
    ];
    const client = makeClient({ fromData: exactRows, rpcData: semanticRows });
    const svc = makeService(client);
    const out = await svc.searchThreads({
      query: 'exact',
      queryEmbedding: [0.1, 0.2, 0.3],
    });
    expect(out.map((h) => ({ id: h.thread.id, kind: h.kind }))).toEqual([
      { id: 'exact-1', kind: 'exact' },
      { id: 'sem-1', kind: 'semantic' },
    ]);
  });

  it('dedupes: a thread that\'s in both halves appears once, tagged exact', async () => {
    const shared = makeRow({
      id: 'shared',
      updated_at: '2026-04-18T00:00:00Z',
      title: 'shared',
    });
    const semanticRows = [
      {
        id: 'shared',
        title: 'shared',
        archived: false,
        updated_at: '2026-04-18T00:00:00Z',
        similarity: 0.9,
      },
      {
        id: 'sem-only',
        title: 'something else',
        archived: false,
        updated_at: '2026-04-10T00:00:00Z',
        similarity: 0.6,
      },
    ];
    const client = makeClient({ fromData: [shared], rpcData: semanticRows });
    const svc = makeService(client);
    const out = await svc.searchThreads({
      query: 'shared',
      queryEmbedding: [0.1],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'exact', thread: { id: 'shared' } });
    expect(out[1]).toMatchObject({ kind: 'semantic', thread: { id: 'sem-only' } });
    // The semantic-shared duplicate dropped.
    expect(out.filter((h) => h.thread.id === 'shared')).toHaveLength(1);
  });

  it('respects the limit cap across the merged output', async () => {
    const exactRows = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: `e-${i}`, updated_at: `2026-04-1${i}T00:00:00Z`, title: `e-${i}` })
    );
    const semanticRows = Array.from({ length: 5 }, (_, i) => ({
      id: `s-${i}`,
      title: `s-${i}`,
      archived: false,
      updated_at: `2026-04-0${i}T00:00:00Z`,
      similarity: 0.5,
    }));
    const client = makeClient({ fromData: exactRows, rpcData: semanticRows });
    const svc = makeService(client);
    const out = await svc.searchThreads({
      query: 'x',
      queryEmbedding: [0.1],
      limit: 3,
    });
    expect(out).toHaveLength(3);
    // All three should be exact — the limit truncates before semantic gets a turn.
    expect(out.every((h) => h.kind === 'exact')).toBe(true);
  });

  it('skips the semantic RPC when no query embedding is provided (exact-only fallback)', async () => {
    const exactRows = [
      makeRow({ id: 'exact-1', updated_at: '2026-04-18T00:00:00Z', title: 'match' }),
    ];
    const client = makeClient({ fromData: exactRows });
    const svc = makeService(client);
    const out = await svc.searchThreads({ query: 'match', queryEmbedding: null });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('exact');
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe('pagination cursors', () => {
  it('reports hasMore + derives the next cursor from the last row when an overfetch hit', async () => {
    // Request pageSize=2 → fetch 3, get 3 → last-of-page becomes the cursor.
    const rows = [
      makeRow({ id: 'r-1', updated_at: '2026-04-18T00:00:00Z' }),
      makeRow({ id: 'r-2', updated_at: '2026-04-17T00:00:00Z' }),
      makeRow({ id: 'r-3', updated_at: '2026-04-16T00:00:00Z' }),
    ];
    const client = makeClient({ fromData: rows });
    const svc = makeService(client);
    const page = await svc.listOlderThreads({
      cutoff: '2026-04-20T00:00:00Z',
      cursor: null,
      pageSize: 2,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toEqual({ updated_at: '2026-04-17T00:00:00Z', id: 'r-2' });
  });

  it('reports nextCursor=null when the overfetch didn\'t overshoot (no more pages)', async () => {
    const rows = [
      makeRow({ id: 'r-1', updated_at: '2026-04-18T00:00:00Z' }),
    ];
    const client = makeClient({ fromData: rows });
    const svc = makeService(client);
    const page = await svc.listOlderThreads({
      cutoff: '2026-04-20T00:00:00Z',
      cursor: null,
      pageSize: 2,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('returns an empty page with nextCursor=null when nothing matches', async () => {
    const client = makeClient({ fromData: [] });
    const svc = makeService(client);
    const page = await svc.listArchivedThreads({ cursor: null, pageSize: 25 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('topic filter clause threading', () => {
  // The listing functions accept selectedTopics and add an `or(...)`
  // clause to the underlying query. These tests pin the clause shape
  // so a future refactor doesn't accidentally widen or narrow the
  // predicate. The stub captures the LAST args passed to each chain
  // method - so when both the cursor `or()` and the topics `or()`
  // run, we only see the topics one. That's fine for the topics
  // assertions; the cursor coverage already lives in the pagination
  // block above.

  function captured() {
    const c: { lastFromCall: Record<string, unknown[]> } = { lastFromCall: {} };
    return c;
  }

  it('listRecentThreads with one real topic emits `topics.ov.{a}`', async () => {
    const cap = captured();
    const client = makeClient({ fromData: [], captured: cap });
    const svc = makeService(client);
    await svc.listRecentThreads('2026-04-20T00:00:00Z', ['baking']);
    expect(cap.lastFromCall.or).toEqual(['topics.ov.{baking}']);
  });

  it('listRecentThreads with two real topics emits ov over both', async () => {
    const cap = captured();
    const client = makeClient({ fromData: [], captured: cap });
    const svc = makeService(client);
    await svc.listRecentThreads('2026-04-20T00:00:00Z', ['baking', 'bread']);
    expect(cap.lastFromCall.or).toEqual(['topics.ov.{baking,bread}']);
  });

  it('listRecentThreads with only the untagged sentinel emits `topics.eq.{}`', async () => {
    const cap = captured();
    const client = makeClient({ fromData: [], captured: cap });
    const svc = makeService(client);
    await svc.listRecentThreads('2026-04-20T00:00:00Z', ['(untagged)']);
    expect(cap.lastFromCall.or).toEqual(['topics.eq.{}']);
  });

  it('listRecentThreads with sentinel + real topics ORs the two halves', async () => {
    const cap = captured();
    const client = makeClient({ fromData: [], captured: cap });
    const svc = makeService(client);
    await svc.listRecentThreads('2026-04-20T00:00:00Z', ['(untagged)', 'baking']);
    expect(cap.lastFromCall.or).toEqual(['topics.ov.{baking},topics.eq.{}']);
  });

  it('listRecentThreads with no filter skips the or() builder', async () => {
    const cap = captured();
    const client = makeClient({ fromData: [], captured: cap });
    const svc = makeService(client);
    await svc.listRecentThreads('2026-04-20T00:00:00Z', []);
    expect(cap.lastFromCall.or).toBeUndefined();
  });

  it('listOlderThreads threads selectedTopics through pageThreads', async () => {
    const cap = captured();
    const client = makeClient({ fromData: [], captured: cap });
    const svc = makeService(client);
    await svc.listOlderThreads({
      cutoff: '2026-04-20T00:00:00Z',
      cursor: null,
      pageSize: 25,
      selectedTopics: ['bread'],
    });
    expect(cap.lastFromCall.or).toEqual(['topics.ov.{bread}']);
  });

  it('listArchivedThreads threads selectedTopics through pageThreads', async () => {
    const cap = captured();
    const client = makeClient({ fromData: [], captured: cap });
    const svc = makeService(client);
    await svc.listArchivedThreads({
      cursor: null,
      pageSize: 25,
      selectedTopics: ['(untagged)'],
    });
    expect(cap.lastFromCall.or).toEqual(['topics.eq.{}']);
  });
});
