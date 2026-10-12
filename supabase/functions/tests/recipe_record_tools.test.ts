// Guards for the recipe-record tools (venice/tools/recipe_record_*.ts).
//
// Harness modeled on recipe_save.test.ts's stubbed-adminClient shape,
// extended to a per-table FIFO response queue + call recorder so the
// multi-query handlers (create's ownership pre-check + dedup payload,
// search's two legs) can assert what was sent, not just what came back.
//
// Prompt invariants follow wiki_records.test.ts's style, pinned
// against the browser wire schemas: create's description carries the
// capture trigger (when to log - capture is manual by design; there
// is no background sweep) and the check-list-first dedup guard. The
// cookingToolbox description's copy of the trigger is pinned
// browser-side in tests/tools.test.ts - the browser registry's import
// graph does not resolve under Deno.

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { recipeRecordCreate } from '../venice/tools/recipe_record_create.ts';
import { recipeRecordUpdate } from '../venice/tools/recipe_record_update.ts';
import { recipeRecordDelete } from '../venice/tools/recipe_record_delete.ts';
import { recipeRecordList } from '../venice/tools/recipe_record_list.ts';
import { recipeRecordGet } from '../venice/tools/recipe_record_get.ts';
import { recipeRecordSearch } from '../venice/tools/recipe_record_search.ts';
import { recipeRecordCreateSchema } from '../../../src/lib/tools/recipe_record_create.schema.ts';

// --- localEmbed seam ---------------------------------------------------
//
// localEmbed builds a Supabase.ai.Session lazily on first call; in
// plain Deno that global doesn't exist, so it throws - the embedder-
// failure path fires for free. For the semantic-success tests we
// inject a fake global whose run() is toggled per test via embedBehavior
// (the module caches the session object, so the toggle must live on
// the instance, not in replacement).

let embedBehavior: 'ok' | 'fail' = 'ok';
class FakeSession {
  run(_input: string, _opts: unknown): number[] {
    if (embedBehavior === 'fail') throw new Error('embedder down');
    return new Array(384).fill(0.1);
  }
}
(globalThis as { Supabase?: unknown }).Supabase = {
  ai: { Session: FakeSession },
};

// --- stub harness ------------------------------------------------------

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface RecordedQuery {
  table: string;
  calls: RecordedCall[];
}

interface Ctx {
  ctx: ToolContext;
  queries: RecordedQuery[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

interface Opts {
  // Per-table FIFO of awaited responses; the last entry repeats when
  // the table is awaited more often than scripted.
  rows?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
  rpcResult?: { data?: unknown; error?: { message: string } | null } | null;
  threadId?: string | null;
}

function fakeCtx(opts: Opts = {}): Ctx {
  const queries: RecordedQuery[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tableCounters: Record<string, number> = {};
  const methods = [
    'eq', 'neq', 'lt', 'lte', 'gte', 'ilike', 'contains', 'order', 'limit',
    'select', 'single', 'maybeSingle', 'insert', 'update', 'delete',
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
      // The awaited chain never leaves this object (every chained
      // method returns `c`), so `then` lives directly on it and
      // consumes the table's response queue in FIFO order. The queue
      // position is per TABLE (a handler issues several from() calls
      // against one table); each builder is awaited once. A Proxy
      // that intercepts `then` does NOT work here: only the outer
      // from() call is proxied, and the chained calls run on the raw
      // target, bypassing the trap (see recipe_save.test.ts).
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
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(opts.rpcResult ?? { data: [], error: null });
    },
  } as unknown as SupabaseClient;

  return {
    ctx: {
      adminClient,
      userId: 'u-1',
      threadId: opts.threadId === undefined ? 't-1' : opts.threadId,
      signal: new AbortController().signal,
      depth: 0,
    } as ToolContext,
    queries,
    rpcCalls,
  };
}

function callsOf(query: RecordedQuery, method: string): unknown[][] {
  return query.calls.filter((c) => c.method === method).map((c) => c.args);
}

function firstCall(query: RecordedQuery, method: string): unknown[] | undefined {
  return callsOf(query, method)[0];
}

// --- create ------------------------------------------------------------

const CREATE_ARGS = {
  recipe_id: 'r-1',
  date: '2026-10-04',
  content: 'Crumb came out gummy; ferment longer next time.',
};

Deno.test('recipe_record_create inserts with explicit user_id + thread stamp + outcome/tags', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      recipes: [{ data: { title: 'Sourdough' }, error: null }],
      recipe_records: [
        { data: { id: 'rec-1', date: '2026-10-04', content: 'x' }, error: null },
        { data: [], error: null }, // same-date siblings
        { data: [], error: null }, // most recent strict-prior
      ],
    },
  });
  await recipeRecordCreate.execute(
    { ...CREATE_ARGS, tags: ['rye'], outcome: 'mixed' },
    ctx,
  );
  const rec = queries.find((q) => q.table === 'recipe_records')!;
  const insert = firstCall(rec, 'insert')![0] as Record<string, unknown>;
  // b-strict: user_id stamped on insert so a service-role write can't
  // land under another owner.
  assertEquals(insert.user_id, 'u-1');
  assertEquals(insert.recipe_id, 'r-1');
  assertEquals(insert.date, '2026-10-04');
  assertEquals(insert.tags, ['rye']);
  assertEquals(insert.outcome, 'mixed');
  assertEquals(insert.source_conversation_id, 't-1');
});

Deno.test('recipe_record_create stamps source_conversation_id null outside a thread', async () => {
  const { ctx, queries } = fakeCtx({
    threadId: null,
    rows: {
      recipes: [{ data: { title: 'Sourdough' }, error: null }],
      recipe_records: [
        { data: { id: 'rec-1' }, error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
    },
  });
  await recipeRecordCreate.execute(CREATE_ARGS, ctx);
  const rec = queries.find((q) => q.table === 'recipe_records')!;
  assertEquals(firstCall(rec, 'insert')![0] as Record<string, unknown>, {
    user_id: 'u-1',
    recipe_id: 'r-1',
    date: '2026-10-04',
    content: CREATE_ARGS.content,
    tags: [],
    outcome: null,
    source_conversation_id: null,
  });
});

Deno.test('recipe_record_create result carries the dedup payload (siblings + strict-prior, 120-char previews)', async () => {
  const longBody = 'x'.repeat(200);
  const { ctx } = fakeCtx({
    rows: {
      recipes: [{ data: { title: 'Sourdough' }, error: null }],
      recipe_records: [
        { data: { id: 'rec-new', date: '2026-10-04' }, error: null },
        {
          data: [
            { id: 'rec-sib', date: '2026-10-04', content: longBody },
          ],
          error: null,
        },
        {
          data: [{ id: 'rec-prior', date: '2026-10-01', content: 'earlier' }],
          error: null,
        },
      ],
    },
  });
  const result = (await recipeRecordCreate.execute(CREATE_ARGS, ctx)) as {
    record: { id: string };
    same_date_siblings: Array<{ id: string; content_preview: string }>;
    most_recent_prior: { id: string; content_preview: string } | null;
  };
  assertEquals(result.record.id, 'rec-new');
  // Sibling preview is capped at 120 (the changelog-builder cap).
  assertEquals(result.same_date_siblings.length, 1);
  assertEquals(result.same_date_siblings[0].id, 'rec-sib');
  assertEquals(result.same_date_siblings[0].content_preview.length, 120);
  assertEquals(result.most_recent_prior?.id, 'rec-prior');
});

// The two dedup queries' shapes, asserted directly:
Deno.test('recipe_record_create dedup queries: same-date siblings exclude the new row; prior is strictly earlier', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      recipes: [{ data: { title: 'Sourdough' }, error: null }],
      recipe_records: [
        { data: { id: 'rec-new', date: '2026-10-04' }, error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
    },
  });
  await recipeRecordCreate.execute(CREATE_ARGS, ctx);
  const recQueries = queries.filter((q) => q.table === 'recipe_records');
  assertEquals(recQueries.length, 3);
  const [sib, prior] = recQueries.slice(1);
  // Siblings: same date, not the new row's id.
  assertEquals(firstCall(sib!, 'eq')!.slice(0, 2), ['user_id', 'u-1']);
  assertEquals(callsOf(sib!, 'eq')[1]!.slice(0, 2), ['recipe_id', 'r-1']);
  assertEquals(callsOf(sib!, 'eq')[2]!.slice(0, 2), ['date', '2026-10-04']);
  assertEquals(firstCall(sib!, 'neq')!.slice(0, 2), ['id', 'rec-new']);
  // Prior: strictly before the new record's date, newest first, one row.
  assertEquals(callsOf(prior!, 'eq')[1]!.slice(0, 2), ['recipe_id', 'r-1']);
  assertEquals(firstCall(prior!, 'lt')!.slice(0, 2), ['date', '2026-10-04']);
  assertEquals(firstCall(prior!, 'limit')![0], 1);
  // Newest-first ordering: date desc, then created_at desc.
  assertEquals(firstCall(prior!, 'order'), ['date', { ascending: false }]);
  assertEquals(callsOf(prior!, 'order')[1], ['created_at', { ascending: false }]);
});

Deno.test('recipe_record_create validates args all-at-once and rejects an unknown recipe', async () => {
  const { ctx } = fakeCtx();
  await assertRejects(
    () => recipeRecordCreate.execute({}, ctx),
    Error,
    'recipe_id is required; date is required (ISO "YYYY-MM-DD"); content is required',
  );
  await assertRejects(
    () =>
      recipeRecordCreate.execute(
        { ...CREATE_ARGS, date: '10/04/2026', outcome: 'ok' },
        ctx,
      ),
    Error,
    'date must be ISO 8601 "YYYY-MM-DD" (got "10/04/2026"); outcome must be one of success, mixed, failure',
  );
  await assertRejects(
    () =>
      recipeRecordCreate.execute({ ...CREATE_ARGS, content: 'x'.repeat(8001) }, ctx),
    Error,
    'content exceeds 8000-char limit (got 8001)',
  );
  // Unknown / non-owned parent recipe: refused before any child write.
  const { ctx: missCtx, queries: missQueries } = fakeCtx({
    rows: { recipes: [{ data: null, error: null }] },
  });
  await assertRejects(
    () => recipeRecordCreate.execute(CREATE_ARGS, missCtx),
    Error,
    'No recipe with id "r-1" found for this user',
  );
  assertEquals(
    missQueries.filter((q) => q.table === 'recipe_records').length,
    0,
  );
});

// --- update ------------------------------------------------------------

Deno.test('recipe_record_update patches only the named fields and owner-scopes', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      recipe_records: [
        { data: { id: 'rec-1', date: '2026-10-04' }, error: null },
      ],
    },
  });
  await recipeRecordUpdate.execute(
    { id: 'rec-1', content: 'merged body', tags: ['rye'] },
    ctx,
  );
  const rec = queries.find((q) => q.table === 'recipe_records')!;
  assertEquals(firstCall(rec, 'update')![0], {
    content: 'merged body',
    tags: ['rye'],
  });
  // RLS OFF: the update filters by user_id + id.
  assertEquals(callsOf(rec, 'eq')[0]!.slice(0, 2), ['user_id', 'u-1']);
  assertEquals(callsOf(rec, 'eq')[1]!.slice(0, 2), ['id', 'rec-1']);
});

Deno.test('recipe_record_update outcome: null clears and counts as the one required field', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      recipe_records: [
        { data: { id: 'rec-1', outcome: null }, error: null },
      ],
    },
  });
  const row = (await recipeRecordUpdate.execute(
    { id: 'rec-1', outcome: null },
    ctx,
  )) as { outcome: string | null };
  const rec = queries.find((q) => q.table === 'recipe_records')!;
  // The explicit null must reach the patch (clearing), not be dropped
  // as a spurious null - the whole point of the three-state handling.
  assertEquals(firstCall(rec, 'update')![0], { outcome: null });
  assertEquals(row.outcome, null);
  await assertRejects(
    () => {
      const empty = fakeCtx({ rows: { recipe_records: [{ data: null, error: null }] } });
      return recipeRecordUpdate.execute({ id: 'rec-1' }, empty.ctx);
    },
    Error,
    'nothing to update - pass at least one of date, content, tags, outcome',
  );
});

Deno.test('recipe_record_update validates combined problems in one pass, unknown id throws', async () => {
  const { ctx } = fakeCtx();
  await assertRejects(
    () =>
      recipeRecordUpdate.execute(
        { id: 'rec-1', date: 'tomorrow', content: 'x'.repeat(8001) },
        ctx,
      ),
    Error,
    'date must be ISO 8601 "YYYY-MM-DD" (got "tomorrow"); content exceeds 8000-char limit (got 8001)',
  );
  await assertRejects(
    () =>
      recipeRecordUpdate.execute({ id: 'rec-1', outcome: 'ok' }, ctx),
    Error,
    'outcome must be one of success, mixed, failure (or null to clear)',
  );
  const { ctx: missCtx } = fakeCtx({
    rows: { recipe_records: [{ data: null, error: null }] },
  });
  await assertRejects(
    () => recipeRecordUpdate.execute({ id: 'rec-1', content: 'x' }, missCtx),
    Error,
    'No record with id "rec-1" found for this user.',
  );
});

// --- delete ------------------------------------------------------------

Deno.test('recipe_record_delete reports the flag instead of assuming', async () => {
  const { ctx, queries } = fakeCtx({
    rows: { recipe_records: [{ data: [{ id: 'rec-1' }], error: null }] },
  });
  const hit = (await recipeRecordDelete.execute({ id: 'rec-1' }, ctx)) as {
    deleted: boolean;
  };
  assertEquals(hit.deleted, true);
  const rec = queries.find((q) => q.table === 'recipe_records')!;
  // RLS OFF: user_id + id filters on the delete.
  assertEquals(callsOf(rec, 'eq')[0]!.slice(0, 2), ['user_id', 'u-1']);
  assertEquals(callsOf(rec, 'eq')[1]!.slice(0, 2), ['id', 'rec-1']);

  const { ctx: missCtx } = fakeCtx({
    rows: { recipe_records: [{ data: [], error: null }] },
  });
  const miss = (await recipeRecordDelete.execute({ id: 'rec-1' }, missCtx)) as {
    deleted: boolean;
  };
  assertEquals(miss.deleted, false);
  await assertRejects(
    () => recipeRecordDelete.execute({}, ctx),
    Error,
    'id is required',
  );
});

// --- list + get ----------------------------------------------------------

Deno.test('recipe_record_list applies date/tag/outcome filters and clamps the limit', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      recipe_records: [{ data: [{ id: 'rec-1' }], error: null }],
    },
  });
  const res = (await recipeRecordList.execute(
    {
      recipe_id: 'r-1',
      from_date: '2026-10-01',
      to_date: '2026-10-31',
      tags: ['rye'],
      outcome: 'failure',
      limit: 5,
    },
    ctx,
  )) as { records: unknown[] };
  assertEquals(res.records.length, 1);
  const rec = queries.find((q) => q.table === 'recipe_records')!;
  assertEquals(callsOf(rec, 'eq')[0]!.slice(0, 2), ['user_id', 'u-1']);
  assertEquals(callsOf(rec, 'eq')[1]!.slice(0, 2), ['recipe_id', 'r-1']);
  assertEquals(firstCall(rec, 'gte')!.slice(0, 2), ['date', '2026-10-01']);
  assertEquals(firstCall(rec, 'lte')!.slice(0, 2), ['date', '2026-10-31']);
  assertEquals(firstCall(rec, 'contains')!.slice(0, 2), ['tags', ['rye']]);
  assertEquals(callsOf(rec, 'eq')[2]!.slice(0, 2), ['outcome', 'failure']);
  assertEquals(firstCall(rec, 'limit')![0], 5);
  // Newest event first, created_at as the tie-break (two cooks on one
  // date are a normal case).
  assertEquals(firstCall(rec, 'order'), ['date', { ascending: false }]);
  assertEquals(callsOf(rec, 'order')[1], ['created_at', { ascending: false }]);

  // Default and max clamps.
  const { ctx: defCtx, queries: defQueries } = fakeCtx({
    rows: { recipe_records: [{ data: [], error: null }] },
  });
  await recipeRecordList.execute({ recipe_id: 'r-1' }, defCtx);
  const defRec = defQueries.find((q) => q.table === 'recipe_records')!;
  assertEquals(firstCall(defRec, 'limit')![0], 50);
  const { ctx: maxCtx, queries: maxQueries } = fakeCtx({
    rows: { recipe_records: [{ data: [], error: null }] },
  });
  await recipeRecordList.execute({ recipe_id: 'r-1', limit: 1000 }, maxCtx);
  const maxRec = maxQueries.find((q) => q.table === 'recipe_records')!;
  assertEquals(firstCall(maxRec, 'limit')![0], 200);
});

Deno.test('recipe_record_get returns found vs not-found', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      recipe_records: [
        { data: { id: 'rec-1', content: 'body' }, error: null },
      ],
    },
  });
  const hit = (await recipeRecordGet.execute({ id: 'rec-1' }, ctx)) as {
    found: boolean;
  };
  assertEquals(hit.found, true);
  const rec = queries.find((q) => q.table === 'recipe_records')!;
  assertEquals(callsOf(rec, 'eq')[0]!.slice(0, 2), ['user_id', 'u-1']);
  assertEquals(callsOf(rec, 'eq')[1]!.slice(0, 2), ['id', 'rec-1']);

  const { ctx: missCtx } = fakeCtx({
    rows: { recipe_records: [{ data: null, error: null }] },
  });
  const miss = (await recipeRecordGet.execute({ id: 'rec-1' }, missCtx)) as {
    found: boolean;
  };
  assertEquals(miss.found, false);
});

// --- search ------------------------------------------------------------

Deno.test('recipe_record_search throws on an empty query', async () => {
  const { ctx } = fakeCtx();
  await assertRejects(
    () => recipeRecordSearch.execute({ query: '   ' }, ctx),
    Error,
    'query is required',
  );
});

Deno.test('recipe_record_search merges semantic + ILIKE legs, deduping by id and capping at the limit', async () => {
  embedBehavior = 'ok';
  const { ctx, queries, rpcCalls } = fakeCtx({
    rows: {
      recipe_records: [
        {
          data: [
            { id: 'i1', date: '2026-10-02' },
            { id: 'shared', date: '2026-10-01' },
          ],
          error: null,
        },
      ],
    },
    rpcResult: {
      data: [
        { id: 's1', date: '2026-10-03', similarity: 0.9 },
        { id: 'shared', date: '2026-10-01', similarity: 0.8 },
        { id: 's2', date: '2026-09-30', similarity: 0.7 },
      ],
      error: null,
    },
  });
  const res = (await recipeRecordSearch.execute(
    { query: 'gummy crumb', limit: 3 },
    ctx,
  )) as { records: Array<{ id: string }> };
  // Semantic hits first, then ILIKE hits the vector path missed
  // ('shared' deduped), capped at the limit of 3 (i1 dropped).
  assertEquals(res.records.map((r) => r.id), ['s1', 'shared', 's2']);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].name, 'search_recipe_records_by_embedding');
  assertEquals(rpcCalls[0].args.p_user_id, 'u-1');
  assertEquals(rpcCalls[0].args.match_limit, 3);
  // The ILIKE leg ran as its own query.
  assertEquals(queries.length, 1);
  assertEquals(queries[0].table, 'recipe_records');
});

Deno.test('recipe_record_search falls back to ILIKE-only when the embedder fails', async () => {
  embedBehavior = 'fail';
  try {
    const { ctx, queries, rpcCalls } = fakeCtx({
      rows: {
        recipe_records: [
          {
            data: [{ id: 'i1', date: '2026-10-02' }],
            error: null,
          },
        ],
      },
    });
    const res = (await recipeRecordSearch.execute(
      { query: 'gummy crumb' },
      ctx,
    )) as { records: Array<{ id: string }> };
    // Deliberate divergence from the wiki twin: ILIKE hits instead of
    // an empty result while the embedder is down.
    assertEquals(res.records.map((r) => r.id), ['i1']);
    assertEquals(rpcCalls.length, 0);
    assertEquals(queries.length, 1);
  } finally {
    embedBehavior = 'ok';
  }
});

Deno.test('recipe_record_search filters reach both legs', async () => {
  embedBehavior = 'ok';
  const { ctx, queries, rpcCalls } = fakeCtx({
    rows: {
      recipe_records: [{ data: [], error: null }],
    },
  });
  await recipeRecordSearch.execute(
    { query: 'rye', recipe_id: 'r-9', outcome: 'failure' },
    ctx,
  );
  // Semantic leg: filters ride the RPC params.
  assertEquals(rpcCalls[0].args.p_recipe_id, 'r-9');
  assertEquals(rpcCalls[0].args.p_outcome, 'failure');
  // ILIKE leg: the same filters as standalone .eq()s, plus the
  // b-strict user_id guard.
  const rec = queries[0];
  assertEquals(callsOf(rec, 'eq')[0]!.slice(0, 2), ['user_id', 'u-1']);
  assertEquals(callsOf(rec, 'eq')[1]!.slice(0, 2), ['recipe_id', 'r-9']);
  assertEquals(callsOf(rec, 'eq')[2]!.slice(0, 2), ['outcome', 'failure']);
});

Deno.test('recipe_record_search ILIKE pattern is the standalone-filter shape, not the logic-tree builder', async () => {
  embedBehavior = 'fail';
  try {
    const { ctx, queries } = fakeCtx({
      rows: { recipe_records: [{ data: [], error: null }] },
    });
    await recipeRecordSearch.execute({ query: 'gummy crumb' }, ctx);
    const rec = queries[0];
    const pattern = firstCall(rec, 'ilike')![1] as string;
    assertEquals(pattern, '%gummy crumb%');
    // A query containing a double quote must not come back wrapped in
    // quotes: PostgREST strips surrounding quotes only inside a logic
    // tree, so the quoted builder would hunt for literal quote chars
    // and the leg would be dead (the wiki twin's data-layer bug).
    const { ctx: qCtx, queries: qQueries } = fakeCtx({
      rows: { recipe_records: [{ data: [], error: null }] },
    });
    await recipeRecordSearch.execute({ query: 'joy "bread"' }, qCtx);
    const qPattern = firstCall(qQueries[0], 'ilike')![1] as string;
    assertEquals(qPattern, '%joy "bread"%');
  } finally {
    embedBehavior = 'ok';
  }
});

Deno.test('recipe_record_search clamps the limit to 1..30', async () => {
  embedBehavior = 'fail';
  try {
    const { ctx, queries } = fakeCtx({
      rows: { recipe_records: [{ data: [], error: null }] },
    });
    await recipeRecordSearch.execute({ query: 'x', limit: 99 }, ctx);
    assertEquals(firstCall(queries[0], 'limit')![0], 30);
    const { ctx: lowCtx, queries: lowQueries } = fakeCtx({
      rows: { recipe_records: [{ data: [], error: null }] },
    });
    await recipeRecordSearch.execute({ query: 'x', limit: 0 }, lowCtx);
    assertEquals(firstCall(lowQueries[0], 'limit')![0], 1);
  } finally {
    embedBehavior = 'ok';
  }
});

// --- prompt invariants ---------------------------------------------------

Deno.test('create description carries the capture trigger and the check-list-first dedup guard', () => {
  const d = recipeRecordCreateSchema.description;
  // WHEN-to-log trigger: capture is prompt-driven (no sweep), so this
  // sentence is the capture path's brain. It must survive rewording.
  assertStringIncludes(d, 'reports having cooked a recipe and how it went');
  assertStringIncludes(d, 'say so in the reply');
  assertStringIncludes(d, 'not today');
  assertStringIncludes(d, 'ask instead of guessing');
  // The guard is check-list-first: list, match the EVENT (not the
  // date), update instead of stacking.
  assertStringIncludes(d, 'recipe_record_list');
  assertStringIncludes(d, 'same EVENT, not the same date');
  assertStringIncludes(d, 'recipe_record_update');
  // The spurious-null hazard on the optional outcome.
  assertStringIncludes(d, 'omit unless setting or clearing');
});
