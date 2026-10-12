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
import {
  fetchRecipeTitles,
  listRecipeRecords,
  searchRecipeRecords,
} from '../src/lib/supabase/recipe-records';
import { searchRecipeRecordsSemantic } from '../src/lib/recipe-records-search';
import {
  DELETED_RECIPE_LABEL,
  HIT_TITLE_UNAVAILABLE_LABEL,
  RECIPE_RECORD_SEARCH_LIMIT,
  browseFiltersActive,
  contentPreview,
  expandedRowActions,
  formatRecordDate,
  hitClickable,
  hitLabel,
  hitTitleStateFromBatch,
  listFiltersFromBrowse,
  offlineNoDataMessage,
  outcomeChipClass,
  outcomeChipLabel,
  outcomeFilterOptions,
  outcomeFormOptions,
  parseTags,
  pruneExpandedId,
  recordActionTitle,
  recordExportFilename,
  recordSlug,
  recordsEmptyMessage,
  recordsHeadline,
  reduceRecipeRecordRetention,
  resetsOnRecipeChange,
  retentionEntryFor,
  serializeTags,
  todayIso,
  validateRecordForm,
  type RecipeRecordRetentionMap,
} from '../src/lib/ui/recipe-records';
import {
  MAX_RECIPE_RECORD_CONTENT_CHARS,
  MAX_RECIPE_RECORD_TAGS,
  MAX_RECIPE_RECORD_TAG_CHARS,
} from '../supabase/functions/_shared/recipe-record-limits';

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

// --- retention map (the offline degradation's core state) ---------------

describe('reduceRecipeRecordRetention', () => {
  it('files a landed fetch under the id it was FOR', () => {
    // The late-response race: a fetch for A landing after the open id
    // changed to B must land in the map under A, never clobber the view.
    const rows = [makeRow({ id: 'a1' }) as unknown as RecipeRecord];
    const map = reduceRecipeRecordRetention(new Map(), {
      type: 'fetch-landed',
      recipeId: 'A',
      rows,
    });
    expect(retentionEntryFor(map, 'A')).toEqual({ kind: 'rows', rows });
    expect(retentionEntryFor(map, 'B')).toBeNull();
  });

  it('a landed fetch REPLACES the entry - revalidation must be able to un-filter', () => {
    const scoped = [makeRow({ id: 'x' }) as unknown as RecipeRecord];
    const fresh = [makeRow({ id: 'y' }) as unknown as RecipeRecord];
    let map: RecipeRecordRetentionMap = new Map([
      ['A', { kind: 'rows', rows: scoped }],
    ]);
    map = reduceRecipeRecordRetention(map, { type: 'fetch-landed', recipeId: 'A', rows: fresh });
    expect(retentionEntryFor(map, 'A')).toEqual({ kind: 'rows', rows: fresh });
  });

  it('a cold fetch failure lands error; a failed revalidation keeps the rows', () => {
    let map: RecipeRecordRetentionMap = new Map();
    map = reduceRecipeRecordRetention(map, { type: 'fetch-failed', recipeId: 'A' });
    expect(retentionEntryFor(map, 'A')).toEqual({ kind: 'error' });
    // Now with rows already rendered, a failed refetch keeps them.
    const rows = [makeRow({ id: 'keep' }) as unknown as RecipeRecord];
    map = reduceRecipeRecordRetention(map, { type: 'fetch-landed', recipeId: 'B', rows });
    map = reduceRecipeRecordRetention(map, { type: 'fetch-failed', recipeId: 'B' });
    expect(retentionEntryFor(map, 'B')).toEqual({ kind: 'rows', rows });
  });

  it('open-id-changed is a no-op - the map is keyed per id by construction', () => {
    const rows = [makeRow({ id: 'a1' }) as unknown as RecipeRecord];
    const before: RecipeRecordRetentionMap = new Map([
      ['A', { kind: 'rows', rows }],
    ]);
    expect(reduceRecipeRecordRetention(before, { type: 'open-id-changed' })).toBe(before);
  });

  it('returns a new map so a reactive caller sees the change', () => {
    const before: RecipeRecordRetentionMap = new Map();
    const after = reduceRecipeRecordRetention(before, {
      type: 'fetch-landed',
      recipeId: 'A',
      rows: [],
    });
    expect(after).not.toBe(before);
  });
});

// --- browse filters -------------------------------------------------------

describe('listFiltersFromBrowse / browseFiltersActive', () => {
  it('drops empty controls and wraps the single tag selection', () => {
    expect(
      listFiltersFromBrowse({ fromDate: '2026-10-01', toDate: '', tag: 'rye', outcome: '' })
    ).toEqual({ fromDate: '2026-10-01', tags: ['rye'] });
    expect(listFiltersFromBrowse({ fromDate: '', toDate: '', tag: '', outcome: '' })).toEqual({});
    expect(
      listFiltersFromBrowse({ fromDate: '', toDate: '2026-10-31', tag: '', outcome: 'failure' })
    ).toEqual({ toDate: '2026-10-31', outcome: 'failure' });
  });

  it('reports whether any filter is set (empty-state copy selection)', () => {
    const empty = { fromDate: '', toDate: '', tag: '', outcome: '' };
    expect(browseFiltersActive(empty)).toBe(false);
    expect(browseFiltersActive({ ...empty, outcome: 'mixed' })).toBe(true);
    expect(browseFiltersActive({ ...empty, tag: 'rye' })).toBe(true);
  });
});

// --- outcome chips ---------------------------------------------------------

describe('outcome chips', () => {
  it('labels the three classifications, null for unclassified rows', () => {
    expect(outcomeChipLabel('success')).toBe('Success');
    expect(outcomeChipLabel('mixed')).toBe('Mixed');
    expect(outcomeChipLabel('failure')).toBe('Failure');
    expect(outcomeChipLabel(null)).toBeNull();
    // Defensively, a value outside the check constraint renders no chip.
    expect(outcomeChipLabel('excellent')).toBeNull();
  });

  it('maps the same values to chip classes', () => {
    expect(outcomeChipClass('success')).toBe('recipe-record-outcome-success');
    expect(outcomeChipClass('mixed')).toBe('recipe-record-outcome-mixed');
    expect(outcomeChipClass('failure')).toBe('recipe-record-outcome-failure');
    expect(outcomeChipClass(null)).toBeNull();
  });

  it('form options lead with Unclassified; filter options have no unclassified mode', () => {
    expect(outcomeFormOptions()[0]).toEqual({ value: '', label: 'Unclassified' });
    expect(outcomeFormOptions().map((o) => o.value)).toEqual(['', 'success', 'mixed', 'failure']);
    expect(outcomeFilterOptions()[0]).toEqual({ value: '', label: 'All' });
    // "Show me my unclassified bakes" is not a promised surface.
    expect(outcomeFilterOptions().some((o) => o.label === 'Unclassified')).toBe(false);
  });
});

// --- date + preview ---------------------------------------------------------

describe('formatRecordDate / todayIso', () => {
  it('formats an ISO date as "Mon D, YYYY" without UTC day drift', () => {
    expect(formatRecordDate('2026-10-04')).toBe('Oct 4, 2026');
    // A bare YYYY-MM-DD is parsed as a LOCAL date, not UTC midnight -
    // in negative-offset timezones a UTC parse renders the prior day.
    expect(formatRecordDate('2026-01-01')).not.toBe('Dec 31, 2025');
  });

  it('falls back to the raw string for garbage input', () => {
    expect(formatRecordDate('not-a-date')).toBe('not-a-date');
  });

  it('todayIso yields the local YYYY-MM-DD', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('contentPreview', () => {
  it('strips markdown syntax and collapses whitespace', () => {
    // Block markers lose the marker, not the text - a heading's words
    // still show in the preview.
    expect(contentPreview('# Heading\n\n**bold** and `code`', 100)).toBe(
      'Heading bold and code'
    );
  });

  it('truncates with an ellipsis at the cap', () => {
    const out = contentPreview('x'.repeat(150), 100);
    expect(out.length).toBe(101);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('parseTags / serializeTags', () => {
  it('splits, trims, and dedupes case-insensitively', () => {
    expect(parseTags(' rye, Rye, less-salt ,, variation ')).toEqual([
      'rye',
      'less-salt',
      'variation',
    ]);
  });

  it('enforces the shared caps (per-tag length, tag count)', () => {
    // An over-long tag is truncated to the cap, not dropped.
    const long = parseTags('x'.repeat(MAX_RECIPE_RECORD_TAG_CHARS + 5));
    expect(long).toHaveLength(1);
    expect(long[0]!.length).toBe(MAX_RECIPE_RECORD_TAG_CHARS);
    const many = Array.from({ length: MAX_RECIPE_RECORD_TAGS + 5 }, (_, i) => `tag${i}`);
    expect(parseTags(many.join(','))).toHaveLength(MAX_RECIPE_RECORD_TAGS);
  });

  it('round-trips through serializeTags', () => {
    const tags = ['rye', 'less-salt'];
    expect(serializeTags(tags)).toBe('rye, less-salt');
    expect(parseTags(serializeTags(tags))).toEqual(tags);
  });
});

// --- headlines, empty states, write-control copy ------------------------------

describe('recordsHeadline / empty-state copy', () => {
  it('omits the count at zero', () => {
    expect(recordsHeadline(0)).toBe('Records');
    expect(recordsHeadline(12)).toBe('Records (12)');
  });

  it('picks the empty-state line by remedy', () => {
    expect(recordsEmptyMessage({ filtered: false, searching: false })).toMatch(/No records yet/);
    expect(recordsEmptyMessage({ filtered: true, searching: false })).toMatch(/current filters/);
    expect(recordsEmptyMessage({ filtered: false, searching: true })).toMatch(/your search/);
  });

  it('the offline-no-data line never reads as an empty log', () => {
    expect(offlineNoDataMessage()).toMatch(/offline/i);
    expect(offlineNoDataMessage()).not.toMatch(/no records yet/i);
  });

  it('write controls degrade with copy, bookmark-style', () => {
    expect(recordActionTitle(true, 'add')).toBe('Add record');
    expect(recordActionTitle(false, 'add')).toBe('Reconnect to add records');
    expect(recordActionTitle(false, 'delete')).toBe('Reconnect to delete records');
  });
});

// --- cross-recipe hit labels ----------------------------------------------------

describe('hit labels', () => {
  const ok = hitTitleStateFromBatch(new Map([['r2', 'Sourdough']]));
  const failed = hitTitleStateFromBatch(null);

  it('leaves rows on the open recipe unannotated', () => {
    expect(hitLabel(ok, 'r1', 'r1')).toBeNull();
  });

  it('annotates foreign hits with the batch-resolved title', () => {
    expect(hitLabel(ok, 'r2', 'r1')).toBe('Sourdough');
  });

  it('a batch miss is the only "(deleted recipe)" path', () => {
    expect(hitLabel(ok, 'gone', 'r1')).toBe(DELETED_RECIPE_LABEL);
  });

  it('a batch FAILURE degrades every foreign row to "couldn\'t load", not deletion', () => {
    expect(hitLabel(failed, 'r2', 'r1')).toBe(HIT_TITLE_UNAVAILABLE_LABEL);
    expect(hitLabel(failed, 'gone', 'r1')).toBe(HIT_TITLE_UNAVAILABLE_LABEL);
  });

  it('clicks: confirmed-deleted is a no-op; everything else navigates', () => {
    expect(hitClickable(ok, 'gone')).toBe(false);
    expect(hitClickable(ok, 'r2')).toBe(true);
    // A network blip must not read as deletion - the row stays
    // clickable and cached recipes still open.
    expect(hitClickable(failed, 'r2')).toBe(true);
  });

  it('the failed state folds from a null batch result', () => {
    expect(hitTitleStateFromBatch(new Map()).status).toBe('ok');
    expect(hitTitleStateFromBatch(null).status).toBe('failed');
  });
});

// --- expanded-row affordances + pruning ------------------------------------------

describe('expandedRowActions / pruneExpandedId', () => {
  it('Edit/Delete follow the open recipe; Export always renders', () => {
    expect(expandedRowActions('r1', 'r1')).toEqual({ edit: true, export: true, delete: true });
    // A kept-expanded hit whose recipe stopped matching loses the
    // mutation affordances - the form can never write a foreign
    // recipe's record from the new pane.
    expect(expandedRowActions('r2', 'r1')).toEqual({ edit: false, export: true, delete: false });
  });

  it('prunes an expansion no longer in the rendered set', () => {
    const rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' })] as unknown as RecipeRecord[];
    expect(pruneExpandedId('a', rows)).toBe('a');
    expect(pruneExpandedId('gone', rows)).toBeNull();
    expect(pruneExpandedId(null, rows)).toBeNull();
  });
});

// --- reset rules (the state matrix) -------------------------------------------------

describe('resetsOnRecipeChange', () => {
  it('outcome + expanded row reset only in browse mode', () => {
    expect(resetsOnRecipeChange(false)).toEqual({ outcome: true, expandedRow: true });
    // While a search is live the outcome filters the search (resetting
    // it would desync the dropdown from the displayed results) and a
    // search-result expansion survives until the search clears.
    expect(resetsOnRecipeChange(true)).toEqual({ outcome: false, expandedRow: false });
  });
});

// --- validation + export filenames ---------------------------------------------------

describe('validateRecordForm', () => {
  it('requires content and the YYYY-MM-DD date shape', () => {
    expect(validateRecordForm('', '2026-10-04')).toBe('Content is required.');
    expect(validateRecordForm('Baked a loaf', '10/04/2026')).toBe('Pick a valid date.');
    expect(validateRecordForm('Baked a loaf', '')).toBe('Pick a valid date.');
    expect(validateRecordForm('Baked a loaf', '2026-10-04')).toBeNull();
  });

  it('enforces the shared content cap with the cap in the copy', () => {
    expect(validateRecordForm('x'.repeat(MAX_RECIPE_RECORD_CONTENT_CHARS + 1), '2026-10-04')).toBe(
      `Content must be ${MAX_RECIPE_RECORD_CONTENT_CHARS} chars or fewer.`
    );
  });
});

describe('recordSlug / recordExportFilename', () => {
  it('slugs the content to lowercase alphanumerics + hyphens', () => {
    expect(recordSlug({ id: 'id-1', content: 'Crumb came out gummy!' })).toBe(
      'crumb-came-out-gummy'
    );
  });

  it('falls back to the id tail so same-date records never collide on an empty slug', () => {
    expect(recordSlug({ id: 'abcd1234-rest', content: '???' })).toBe('abcd1234');
  });

  it('the export filename is yyyy-mm-dd-<slug>.md', () => {
    expect(
      recordExportFilename({ id: 'id-1', date: '2026-10-04T00:00:00Z', content: 'Gummy crumb' })
    ).toBe('2026-10-04-gummy-crumb.md');
    // An unparseable date degrades to a stable prefix, not a crash.
    expect(recordExportFilename({ id: 'id-1', date: 'x', content: 'Gummy crumb' })).toBe(
      'undated-gummy-crumb.md'
    );
  });

  it('the search cap is a named tunable next to RecipeList\'s', () => {
    expect(RECIPE_RECORD_SEARCH_LIMIT).toBe(20);
  });
});

describe('listRecipeRecords (jsonb tag filter)', () => {
  // Regression guard for the QA round-1 bug: supabase-js serializes a
  // raw JS array as a Postgres array literal (`cs.{a,b}`), which
  // PostgREST rejects against a jsonb column with a 400 (22P02). The
  // wire must carry the JSON-stringified containment form.
  it('serializes the tags filter as a JSON array string, not a Postgres literal', async () => {
    const { client, calls } = makeClient({ fromData: [] });
    await listRecipeRecords(client, 'r1', { tags: ['zzqa-rye', 'high-hydration'] });
    expect(calls.contains?.[0]).toEqual([
      'tags',
      JSON.stringify(['zzqa-rye', 'high-hydration']),
    ]);
  });

  it('sends no contains filter when tags are absent or empty', async () => {
    const { client, calls } = makeClient({ fromData: [] });
    await listRecipeRecords(client, 'r1', {});
    await listRecipeRecords(client, 'r1', { tags: [] });
    expect(calls.contains).toBeUndefined();
  });
});
