/**
 * Unit coverage for the recipe-records data layer: the coercer, the
 * cross-recipe search merge (the merge lives in
 * src/lib/supabase/recipe-records.ts; the wrapper embeds the query and
 * delegates), and the batched title lookup. The supabase-js client is
 * a hand-rolled stub (same shape as tests/thread-search-and-pagination.test.ts)
 * so the assertions pin the request shape - ILIKE pattern, eq filters,
 * rpc args, limit - without booting Postgres. Pure vitest, no DOM.
 *
 * The ILIKE pattern-shape assertions are load-bearing: the merge's
 * `.ilike()` leg is a STANDALONE filter and must carry the bare
 * `%query%` pattern. The wiki twin shipped this leg with the
 * logic-tree pattern (which wraps the value in literal double quotes
 * that PostgREST only strips inside a logic tree), leaving the leg
 * effectively dead - see query-utils.ts. These tests fail if the
 * recipe merge inherits that bug or the twin regresses.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseService } from '../src/lib/supabase';
import { coerceRecipeRecord } from '../src/lib/supabase/types/cookbook';
import type { RecipeRecord } from '../src/lib/supabase/types/cookbook';
import { fetchRecipeTitles, searchRecipeRecords } from '../src/lib/supabase/recipe-records';
import { searchRecipeRecordsSemantic } from '../src/lib/recipe-records-search';

// --- stubs -------------------------------------------------------------------

type Calls = Record<string, unknown[][]>;

/**
 * Chainable from()-builder stub capturing every method's args (in
 * order, so multi-call methods like eq can be asserted per call), plus
 * an rpc stub with its own capture. `then` resolves like supabase-js's
 * thenable query builder.
 */
function makeClient(opts: { fromData?: unknown[]; rpcData?: unknown[]; rpcError?: unknown } = {}) {
  const calls: Calls = {};
  let rpcArgs: Record<string, unknown> | null = null;
  const builder: Record<string, unknown> = {};
  const chainable = [
    'select',
    'eq',
    'ilike',
    'gte',
    'lte',
    'in',
    'contains',
    'order',
    'limit',
    'insert',
    'update',
    'delete',
    'single',
    'maybeSingle',
  ];
  for (const m of chainable) {
    builder[m] = vi.fn((...args: unknown[]) => {
      (calls[m] ??= []).push(args);
      return builder;
    });
  }
  builder.then = (resolve: (v: unknown) => void) => {
    resolve({ data: opts.fromData ?? [], error: null });
    return builder;
  };
  const client = {
    from: vi.fn(() => builder),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcArgs = args;
      void name;
      return { data: opts.rpcData ?? [], error: opts.rpcError ?? null };
    }),
  } as unknown as SupabaseClient;
  return { client, calls, rpcArgs: () => rpcArgs };
}

function makeRow(over: Partial<RecipeRecord> = {}): Record<string, unknown> {
  return {
    id: 'rec-1',
    user_id: 'user-1',
    recipe_id: 'recipe-1',
    date: '2026-10-04',
    content: 'Baked a loaf',
    tags: [],
    outcome: null,
    source_conversation_id: null,
    created_at: '2026-10-04T00:00:00Z',
    updated_at: '2026-10-04T00:00:00Z',
    ...over,
  };
}

/**
 * Stub for the wrapper's injected deps: the wrapper only needs
 * `embed` and `searchRecipeRecords` on the service. Captures the opts
 * each searchRecipeRecords call received.
 */
function makeServiceStub(opts: { embedding?: number[]; embedThrows?: boolean } = {}) {
  const searchCalls: Record<string, unknown>[] = [];
  const stub = {
    embed: vi.fn(async () => {
      if (opts.embedThrows) throw new Error('venice down');
      return { data: [{ embedding: opts.embedding ?? [0.1, 0.2] }] };
    }),
    searchRecipeRecords: vi.fn(async (o: Record<string, unknown>) => {
      searchCalls.push(o);
      return [] as RecipeRecord[];
    }),
  };
  return { stub: stub as unknown as SupabaseService, searchCalls };
}

// --- coercer -------------------------------------------------------------------

describe('coerceRecipeRecord', () => {
  it('coerces a full table row', () => {
    const rec = coerceRecipeRecord(
      makeRow({ tags: ['rye', 'variation'], outcome: 'failure', source_conversation_id: 't-1' })
    );
    expect(rec.id).toBe('rec-1');
    expect(rec.recipe_id).toBe('recipe-1');
    expect(rec.user_id).toBe('user-1');
    expect(rec.date).toBe('2026-10-04');
    expect(rec.content).toBe('Baked a loaf');
    expect(rec.tags).toEqual(['rye', 'variation']);
    expect(rec.outcome).toBe('failure');
    expect(rec.source_conversation_id).toBe('t-1');
    expect(rec.created_at).toBe('2026-10-04T00:00:00Z');
    expect(rec.updated_at).toBe('2026-10-04T00:00:00Z');
    expect(rec.similarity).toBeUndefined();
  });

  it('normalizes a stringified tags payload to a string array', () => {
    const rec = coerceRecipeRecord(makeRow({ tags: '["a","b"]' as unknown as string[] }));
    expect(rec.tags).toEqual(['a', 'b']);
  });

  it('treats malformed / absent tags as untagged rather than throwing', () => {
    expect(coerceRecipeRecord(makeRow({ tags: 'not json' as unknown as string[] })).tags).toEqual([]);
    expect(coerceRecipeRecord(makeRow({ tags: undefined })).tags).toEqual([]);
    expect(coerceRecipeRecord(makeRow({})).tags).toEqual([]);
  });

  it('normalizes empty outcome / conversation to null and carries similarity when present', () => {
    const rec = coerceRecipeRecord(
      makeRow({ id: 'r1', outcome: '', source_conversation_id: '', similarity: 0.42 })
    );
    expect(rec.outcome).toBeNull();
    expect(rec.source_conversation_id).toBeNull();
    expect(rec.similarity).toBe(0.42);
  });

  it('defaults user_id (absent on search-RPC rows) and recipe_id', () => {
    const rec = coerceRecipeRecord({ id: 'r1', content: 'x', created_at: 'c', updated_at: 'u' });
    expect(rec.user_id).toBe('');
    expect(rec.recipe_id).toBe('');
  });
});

// --- search merge ----------------------------------------------------------------

describe('searchRecipeRecords (merge)', () => {
  it('short-circuits an empty query to a recent-first listing and skips the rpc', async () => {
    const rows = [makeRow({ id: 'a' })];
    const { client, calls, rpcArgs } = makeClient({ fromData: rows });
    const out = await searchRecipeRecords(client, { query: '   ', queryEmbedding: null, limit: 5 });
    expect(rpcArgs()).toBeNull();
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(calls.order?.[0]).toEqual(['date', { ascending: false }]);
    expect(calls.limit?.[0]).toEqual([5]);
  });

  it('honors outcome + recipe scope on the empty-query listing', async () => {
    const { client, calls } = makeClient({});
    await searchRecipeRecords(client, {
      query: '',
      queryEmbedding: null,
      outcome: 'failure',
      recipeId: 'recipe-9',
    });
    expect(calls.eq).toEqual([
      ['recipe_id', 'recipe-9'],
      ['outcome', 'failure'],
    ]);
  });

  it('runs both legs in parallel: rpc with p_recipe_id/p_outcome, ilike on content', async () => {
    const { client, calls, rpcArgs } = makeClient({
      fromData: [makeRow({ id: 'ilike-1' })],
      rpcData: [makeRow({ id: 'sem-1' })],
    });
    const out = await searchRecipeRecords(client, {
      query: 'gummy crumb',
      queryEmbedding: [0.1, 0.2],
      outcome: 'failure',
      recipeId: 'recipe-9',
      limit: 7,
    });
    // Semantic hits first, then the ILIKE hits the vector path missed.
    expect(out.map((r) => r.id)).toEqual(['sem-1', 'ilike-1']);
    expect(rpcArgs()).toEqual({
      query_embedding: [0.1, 0.2],
      match_limit: 7,
      p_recipe_id: 'recipe-9',
      p_outcome: 'failure',
    });
    expect(calls.ilike).toEqual([['content', '%gummy crumb%']]);
    // Both legs apply the same scope filters as standalone .eq()s.
    expect(calls.eq).toEqual([
      ['recipe_id', 'recipe-9'],
      ['outcome', 'failure'],
    ]);
  });

  it('dedupes by id: a row in both halves appears once, semantic-first', async () => {
    const { client } = makeClient({
      fromData: [makeRow({ id: 'shared' }), makeRow({ id: 'ilike-only' })],
      rpcData: [makeRow({ id: 'sem-only' }), makeRow({ id: 'shared' })],
    });
    const out = await searchRecipeRecords(client, {
      query: 'loaf',
      queryEmbedding: [0.1],
      limit: 10,
    });
    expect(out.map((r) => r.id)).toEqual(['sem-only', 'shared', 'ilike-only']);
  });

  it('caps the merged result at limit', async () => {
    const { client } = makeClient({
      fromData: [makeRow({ id: 'a' }), makeRow({ id: 'b' }), makeRow({ id: 'c' })],
      rpcData: [makeRow({ id: 'd' }), makeRow({ id: 'e' })],
    });
    const out = await searchRecipeRecords(client, { query: 'loaf', queryEmbedding: [0.1], limit: 3 });
    expect(out.map((r) => r.id)).toEqual(['d', 'e', 'a']);
  });

  it('degrades to ILIKE-only when no embedding is available', async () => {
    const { client, calls, rpcArgs } = makeClient({
      fromData: [makeRow({ id: 'ilike-1' })],
    });
    const out = await searchRecipeRecords(client, { query: 'loaf', queryEmbedding: null });
    expect(rpcArgs()).toBeNull();
    expect(out.map((r) => r.id)).toEqual(['ilike-1']);
    expect(calls.ilike).toEqual([['content', '%loaf%']]);
  });

  it('TWIN-SHAPE REGRESSION: the standalone ilike pattern is bare %query%, never quoted', async () => {
    // The wiki twin built this leg's pattern with ilikeLogicTreePattern,
    // which wraps the value in double quotes PostgREST only strips
    // inside a logic tree - the leg then hunted for literal quote
    // characters and never matched. A quote-carrying query makes the
    // difference visible: the quoted variant would start with `"`.
    const query = 'say "cheese"';
    const { client, calls } = makeClient({ fromData: [] });
    await searchRecipeRecords(client, { query, queryEmbedding: [0.1] });
    const pattern = calls.ilike?.[0]?.[1];
    expect(pattern).toBe(`%${query}%`);
    expect(String(pattern).startsWith('"')).toBe(false);
  });
});

// --- wrapper ---------------------------------------------------------------------

describe('searchRecipeRecordsSemantic (wrapper)', () => {
  it('short-circuits an empty query without calling the embedder', async () => {
    const { stub, searchCalls } = makeServiceStub();
    await searchRecipeRecordsSemantic({
      query: '   ',
      limit: 5,
      outcome: 'mixed',
      recipeId: 'recipe-2',
      supabase: stub,
    });
    expect(stub.embed).not.toHaveBeenCalled();
    expect(searchCalls).toEqual([
      { query: '', queryEmbedding: null, outcome: 'mixed', recipeId: 'recipe-2', limit: 5 },
    ]);
  });

  it('embeds the trimmed query and forwards the padded embedding + filters', async () => {
    const { stub, searchCalls } = makeServiceStub({ embedding: [0.1, 0.2] });
    await searchRecipeRecordsSemantic({
      query: '  gummy crumb ',
      limit: 9,
      outcome: 'failure',
      supabase: stub,
    });
    expect(stub.embed).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'gummy crumb' })
    );
    expect(searchCalls).toHaveLength(1);
    const forwarded = searchCalls[0];
    expect(forwarded.query).toBe('gummy crumb');
    expect(forwarded.outcome).toBe('failure');
    // Pass-through: an omitted scope stays undefined here; the merge
    // normalizes it to null at the RPC boundary (p_recipe_id).
    expect(forwarded.recipeId).toBeUndefined();
    expect(forwarded.limit).toBe(9);
    const embedding = forwarded.queryEmbedding as number[];
    expect(embedding).toHaveLength(2048); // zero-extended to the storage dim
    expect(embedding[0]).toBe(0.1);
    expect(embedding[1]).toBe(0.2);
  });

  it('falls back to ILIKE-only (null embedding) when the embedder fails', async () => {
    const { stub, searchCalls } = makeServiceStub({ embedThrows: true });
    const out = await searchRecipeRecordsSemantic({
      query: 'loaf',
      limit: 5,
      supabase: stub,
    });
    expect(out).toEqual([]);
    expect(searchCalls[0].queryEmbedding).toBeNull();
  });
});

// --- title batch -------------------------------------------------------------------

describe('fetchRecipeTitles', () => {
  it('returns an id -> title Map from one batched .in() query', async () => {
    const { client, calls } = makeClient({
      fromData: [
        { id: 'r1', title: 'Sourdough' },
        { id: 'r2', title: 'Kombucha' },
      ],
    });
    const out = await fetchRecipeTitles(client, ['r1', 'r2']);
    expect(out.get('r1')).toBe('Sourdough');
    expect(out.get('r2')).toBe('Kombucha');
    expect(out.size).toBe(2);
    expect(calls.in).toEqual([['id', ['r1', 'r2']]]);
  });

  it('skips the query entirely for an empty id list', async () => {
    const { client } = makeClient({});
    const out = await fetchRecipeTitles(client, []);
    expect(out.size).toBe(0);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('omits (not nulls) ids that no longer exist - gone recipes render as deleted', async () => {
    const { client } = makeClient({ fromData: [{ id: 'r1', title: 'Sourdough' }] });
    const out = await fetchRecipeTitles(client, ['r1', 'gone']);
    expect(out.has('gone')).toBe(false);
    expect(out.get('r1')).toBe('Sourdough');
  });
});
