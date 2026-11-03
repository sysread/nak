// Guards for the recipe combination tool (venice/tools/recipes.ts:
// list / get / save / delete behind one op enum).
//
// Harness ported from recipe_record_tools.test.ts's stubbed-adminClient
// shape (per-table FIFO + call recorder). The list/get coverage here is
// the pre-merge dependency the combo plan required - neither op had any
// impl test before the conversion. save and delete keep their own
// suites (recipe_save.test.ts, recipe_save_edit_form.test.ts,
// tool-batch.test.ts), ported to this seam at the merge.
//
// RECIPEOPS dispatch: every test drives run(op, args, ctx) so per-op
// assertions survive envelope changes unchanged.

import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { recipes } from '../venice/tools/recipes.ts';

// --- dispatch seam -----------------------------------------------------

// Every test drives the combo def's execute() with op in args, so
// per-op assertions survive envelope changes unchanged.
type RecipeOp = 'list' | 'get' | 'save' | 'delete';

async function run(
  op: RecipeOp,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  return recipes.execute({ op, ...args }, ctx);
}

// --- stub harness ------------------------------------------------------

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

interface Opts {
  rows?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
}

function fakeCtx(opts: Opts = {}): { ctx: ToolContext; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const tableCounters: Record<string, number> = {};
  const methods = [
    'eq', 'neq', 'lt', 'lte', 'gte', 'like', 'ilike', 'contains', 'order',
    'limit', 'select', 'single', 'maybeSingle', 'insert', 'update', 'delete',
  ];
  const adminClient = {
    from: (table: string) => {
      const rec: RecordedQuery = { table, calls: [] };
      queries.push(rec);
      const c: Record<string, unknown> = {};
      for (const m of methods) {
        c[m] = (...a: unknown[]) => {
          rec.calls.push({ method: m, args: a });
          return c;
        };
      }
      const responses = opts.rows?.[table] ?? [];
      const idx = (tableCounters[table] ?? 0);
      tableCounters[table] = idx + 1;
      (c as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
        const res = responses[Math.min(idx, responses.length - 1)] ?? {
          data: [],
          error: null,
        };
        return Promise.resolve(res).then(resolve);
      };
      return c;
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  } as unknown as SupabaseClient;

  return {
    ctx: {
      adminClient,
      userId: 'u-1',
      threadId: 't-1',
      signal: new AbortController().signal,
      depth: 0,
    } as ToolContext,
    queries,
  };
}

function callsOf(query: RecordedQuery, method: string): unknown[][] {
  return query.calls.filter((c) => c.method === method).map((c) => c.args);
}

function firstCall(query: RecordedQuery, method: string): unknown[] | undefined {
  return callsOf(query, method)[0];
}

const LIST_ROW = {
  id: 'r-1',
  title: 'Sourdough',
  source: 'NYT',
  source_url: null,
  rating: 4,
  updated_at: '2026-11-03T00:00:00Z',
};

// --- list --------------------------------------------------------------

Deno.test('list defaults: user filter, limit 100, most-recent-first', async () => {
  const { ctx, queries } = fakeCtx({ rows: { recipes: [{ data: [LIST_ROW], error: null }] } });
  const out = (await run('list', {}, ctx)) as Array<Record<string, unknown>>;

  const rec = queries.find((q) => q.table === 'recipes')!;
  assertEquals(firstCall(rec, 'select')![0], 'id, title, source, source_url, rating, updated_at');
  assertEquals(firstCall(rec, 'eq')![0], 'user_id');
  assertEquals(firstCall(rec, 'eq')![1], 'u-1');
  assertEquals(firstCall(rec, 'limit')![0], 100);
  assertEquals(firstCall(rec, 'order')![0], 'updated_at');
  assertEquals((firstCall(rec, 'order')![1] as Record<string, unknown>).ascending, false);
  // No rating-sort order, no ilike when unfiltered.
  assertEquals(callsOf(rec, 'ilike').length, 0);
  assertEquals(out, [LIST_ROW]);
});

Deno.test('list rating sort orders by rating first, unrated last', async () => {
  const { ctx, queries } = fakeCtx({ rows: { recipes: [{ data: [], error: null }] } });
  await run('list', { sort: 'rating' }, ctx);
  const rec = queries.find((q) => q.table === 'recipes')!;
  const orders = callsOf(rec, 'order');
  assertEquals(orders[0]![0], 'rating');
  assertEquals((orders[0]![1] as Record<string, unknown>).ascending, false);
  assertEquals((orders[0]![1] as Record<string, unknown>).nullsFirst, false);
  assertEquals(orders[1]![0], 'updated_at');
});

Deno.test('list query filters the title with an ILIKE-escaped containment pattern', async () => {
  const { ctx, queries } = fakeCtx({ rows: { recipes: [{ data: [], error: null }] } });
  await run('list', { query: '50% off_the_grid' }, ctx);
  const rec = queries.find((q) => q.table === 'recipes')!;
  const ilike = firstCall(rec, 'ilike')!;
  assertEquals(ilike[0], 'title');
  assertEquals(ilike[1], '%50\\% off\\_the\\_grid%');
});

Deno.test('list clamps the limit into [1, 500]', async () => {
  const { ctx, queries } = fakeCtx({ rows: { recipes: [{ data: [], error: null }] } });
  await run('list', { limit: 10_000 }, ctx);
  assertEquals(firstCall(queries.find((q) => q.table === 'recipes')!, 'limit')![0], 500);

  const { ctx: ctx2, queries: q2 } = fakeCtx({ rows: { recipes: [{ data: [], error: null }] } });
  await run('list', { limit: 0 }, ctx2);
  assertEquals(firstCall(q2.find((q) => q.table === 'recipes')!, 'limit')![0], 1);
});

// --- get ---------------------------------------------------------------

Deno.test('get returns the full row + photo meta for an owned id', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      recipes: [{
        data: {
          id: 'r-1',
          title: 'Sourdough',
          source: null,
          source_url: null,
          cooklang: '>> servings: 1',
          rating: null,
          upcoming: false,
          favorite: true,
          topics: [],
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-03T00:00:00Z',
        },
        error: null,
      }],
      recipe_versions: [{
        data: {
          id: 'v-1',
          recipe_version_images: [
            { position: 1, image_id: 'img-2', label: null },
            { position: 0, image_id: 'img-1', label: 'front' },
          ],
        },
        error: null,
      }],
    },
  });
  const out = (await run('get', { id: 'r-1' }, ctx)) as Record<string, unknown>;

  const rec = queries.find((q) => q.table === 'recipes')!;
  assertEquals(firstCall(rec, 'eq')![1], 'u-1');
  assertEquals(callsOf(rec, 'eq')[1]![1], 'r-1');
  assertEquals((out as { found: boolean }).found, true);
  const recipe = (out as { recipe: Record<string, unknown> }).recipe;
  // Photos sorted by position ascending, label carried.
  assertEquals(recipe.photos, [
    { id: 'img-1', position: 0, label: 'front' },
    { id: 'img-2', position: 1, label: null },
  ]);
});

Deno.test('get reports {found: false} for an unknown or foreign id', async () => {
  const { ctx } = fakeCtx({ rows: { recipes: [{ data: null, error: null }] } });
  const out = (await run('get', { id: 'nope' }, ctx)) as Record<string, unknown>;
  assertEquals(out, { found: false });
});

Deno.test('get validates: id is required', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(() => run('get', {}, ctx), Error, 'id is required');
});
