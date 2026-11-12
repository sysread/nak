// Guards for the grocery combination tool (venice/tools/grocery.ts:
// list / add / remove / update behind one op enum).
//
// Harness ported from recipe_tools.test.ts's stubbed-adminClient
// shape (per-table FIFO + call recorder). Every test drives
// run(op, args, ctx) so per-op assertions survive envelope changes.
//
// The add suite pins the tiered name probe (the deliberate
// asymmetry: a recipe-context add never revives another recipe's
// product; a standalone add may revive any product), the
// revive-before-create idempotence, and the section resolution.
// The remove/update suites pin the open-entry write predicates -
// the raced-purchase guard that keeps purchase history intact.

import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { grocery } from '../venice/tools/grocery.ts';

// --- dispatch seam -----------------------------------------------------

type GroceryOp = 'list' | 'add' | 'remove' | 'update';

async function run(
  op: GroceryOp,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  return grocery.execute({ op, ...args }, ctx);
}

// --- stub harness ------------------------------------------------------

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

interface Opts {
  rows?: Record<string, Array<{ data?: unknown; error?: { message: string; code?: string } | null }>>;
}

function fakeCtx(opts: Opts = {}): { ctx: ToolContext; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const tableCounters: Record<string, number> = {};
  const methods = [
    'eq', 'neq', 'lt', 'lte', 'gte', 'like', 'ilike', 'contains', 'not', 'is',
    'order', 'limit', 'select', 'single', 'maybeSingle', 'insert', 'update', 'delete',
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

function queryOn(queries: RecordedQuery[], table: string): RecordedQuery[] {
  return queries.filter((q) => q.table === table);
}

const SECTIONS = {
  data: [
    { id: 'sec-produce', name: 'Produce', position: 0 },
    { id: 'sec-bakery', name: 'Bakery', position: 1 },
  ],
  error: null,
};

// --- list ---------------------------------------------------------------

Deno.test('grocery list: on_list by default, sections payload, section names resolved', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [
        {
          data: [
            {
              id: 'p1', name: 'flour', note: null, section_id: 'sec-bakery',
              recipe_id: null, recipe_title: null, entry_id: 'e1',
              count: '2', unit: 'kg', acquired_at: null, on_list: true,
              updated_at: '2026-11-12T00:00:00Z',
            },
            {
              id: 'p2', name: 'apples', note: null, section_id: null,
              recipe_id: 'r1', recipe_title: 'Lasagna', entry_id: null,
              count: null, unit: null, acquired_at: null, on_list: false,
              updated_at: '2026-11-11T00:00:00Z',
            },
          ],
          error: null,
        },
      ],
    },
  });

  const result = (await run('list', {}, ctx)) as {
    sections: Array<{ id: string; name: string }>;
    items: Array<Record<string, unknown>>;
  };

  const view = queryOn(queries, 'grocery_products_view')[0]!;
  // RLS OFF discipline: user_id filter on every read.
  assertEquals(callsOf(view, 'eq'), [['user_id', 'u-1'], ['on_list', true]]);
  assertEquals(callsOf(view, 'order'), [['updated_at', { ascending: false }]]);

  assertEquals(result.sections, [
    { id: 'sec-produce', name: 'Produce' },
    { id: 'sec-bakery', name: 'Bakery' },
  ]);
  assertEquals(result.items.length, 2);
  assertEquals(result.items[0]!.section, 'Bakery');
  // The null-section row reads as the unfiled intake, not a name.
  assertEquals(result.items[1]!.section, null);
  assertEquals(result.items[1]!.recipe_title, 'Lasagna');
});

Deno.test('grocery list: acquired status filters off-list + bought, newest first', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [{ data: [], error: null }],
    },
  });

  await run('list', { status: 'acquired' }, ctx);

  const view = queryOn(queries, 'grocery_products_view')[0]!;
  assertEquals(callsOf(view, 'eq'), [['user_id', 'u-1'], ['on_list', false]]);
  // not(is null) - "acquired" means bought, not merely absent.
  assertEquals(callsOf(view, 'not'), [['acquired_at', 'is', null]]);
  assertEquals(callsOf(view, 'order'), [
    ['acquired_at', { ascending: false }],
    ['id', { ascending: false }],
  ]);
});

Deno.test('grocery list: query rides an escaped ILIKE pattern', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [{ data: [], error: null }],
    },
  });

  await run('list', { query: '50%_off' }, ctx);

  const view = queryOn(queries, 'grocery_products_view')[0]!;
  assertEquals(callsOf(view, 'ilike'), [['name', '%50\\%\\_off%']]);
});

Deno.test('grocery list: section filter resolves names, Other matches the unfiled bucket', async () => {
  const base = {
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [{ data: [], error: null }],
    },
  };

  const byName = fakeCtx(base);
  await run('list', { section: 'bakery' }, byName.ctx);
  const viewByName = queryOn(byName.queries, 'grocery_products_view')[0]!;
  // Case-insensitive display-name match -> the row's id. on_list
  // rides along as the default status filter.
  assertEquals(callsOf(viewByName, 'eq'), [
    ['user_id', 'u-1'],
    ['on_list', true],
    ['section_id', 'sec-bakery'],
  ]);

  const other = fakeCtx(base);
  await run('list', { section: 'Other' }, other.ctx);
  const viewOther = queryOn(other.queries, 'grocery_products_view')[0]!;
  assertEquals(callsOf(viewOther, 'is'), [['section_id', null]]);

  const unknown = fakeCtx(base);
  await assertRejects(
    () => run('list', { section: 'Deli' }, unknown.ctx),
    Error,
    'does not match one of your sections',
  );
  await assertRejects(
    () => run('list', { section: 'Deli' }, unknown.ctx),
    Error,
    'Produce, Bakery, Other',
  );
});

Deno.test('grocery list: limit clamps into the 1..500 window', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [{ data: [], error: null }],
    },
  });

  await run('list', { limit: 9999 }, ctx);
  const view = queryOn(queries, 'grocery_products_view')[0]!;
  assertEquals(callsOf(view, 'limit'), [[500]]);
});

// --- add ----------------------------------------------------------------

Deno.test('grocery add: no catalog match creates the product, then opens its entry', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [{ data: [], error: null }],
      grocery_products: [{ data: [{ id: 'p-new' }], error: null }],
    },
  });

  const result = (await run(
    'add',
    { items: [{ name: 'Flour', count: '2', unit: 'kg', section: 'Bakery' }] },
    ctx,
  )) as { results: Array<Record<string, unknown>> };

  const productInsert = queryOn(queries, 'grocery_products')[0]!;
  const insertArgs = callsOf(productInsert, 'insert')[0]![0] as Record<string, unknown>;
  assertEquals(insertArgs.user_id, 'u-1');
  assertEquals(insertArgs.name, 'Flour');
  assertEquals(insertArgs.section_id, 'sec-bakery');
  // A machine-chosen section stamps 'auto' - the classifier never
  // overwrites it and a user refiling still wins.
  assertEquals(insertArgs.section_source, 'auto');
  assertEquals(insertArgs.recipe_id, null);

  const entryInsert = queryOn(queries, 'grocery_list_entries')[0]!;
  const entryArgs = callsOf(entryInsert, 'insert')[0]![0] as Record<string, unknown>;
  assertEquals(entryArgs.product_id, 'p-new');
  assertEquals(entryArgs.count, '2');
  assertEquals(entryArgs.unit, 'kg');

  assertEquals(result.results, [
    { name: 'Flour', status: 'created', product_id: 'p-new' },
  ]);
});

Deno.test('grocery add: off-list catalog match revives, keeping the learned section', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [
        {
          data: [
            {
              id: 'p-flour', name: 'flour', recipe_id: null,
              section_id: 'sec-bakery', on_list: false,
              updated_at: '2026-11-01T00:00:00Z',
            },
          ],
          error: null,
        },
      ],
    },
  });

  const result = (await run(
    'add',
    { items: [{ name: '  Flour ', count: '1', section: 'Produce' }] },
    ctx,
  )) as { results: Array<Record<string, unknown>> };

  // No product row was written - the section on the item is
  // deliberately ignored on revival (browser add-all parity).
  assertEquals(queryOn(queries, 'grocery_products').length, 0);

  const entryInsert = queryOn(queries, 'grocery_list_entries')[0]!;
  const entryArgs = callsOf(entryInsert, 'insert')[0]![0] as Record<string, unknown>;
  assertEquals(entryArgs.product_id, 'p-flour');
  assertEquals(entryArgs.count, '1');

  assertEquals(result.results, [
    { name: 'Flour', status: 'revived', product_id: 'p-flour', matched_name: 'flour' },
  ]);
});

Deno.test('grocery add: already-on-list match is an idempotent reported no-op', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [
        {
          data: [
            {
              id: 'p-butter', name: 'butter', recipe_id: null,
              section_id: null, on_list: true,
              updated_at: '2026-11-01T00:00:00Z',
            },
          ],
          error: null,
        },
      ],
    },
  });

  const result = (await run('add', { items: [{ name: 'Butter' }] }, ctx)) as {
    results: Array<Record<string, unknown>>;
  };

  assertEquals(queryOn(queries, 'grocery_products').length, 0);
  assertEquals(queryOn(queries, 'grocery_list_entries').length, 0);
  assertEquals(result.results, [
    { name: 'Butter', status: 'already_on_list', product_id: 'p-butter', matched_name: 'butter' },
  ]);
});

Deno.test('grocery add: multi-match within the winning tier picks the most recently updated and reports it', async () => {
  const { ctx } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [
        {
          data: [
            {
              id: 'p-old', name: 'corn', recipe_id: null,
              section_id: null, on_list: false,
              updated_at: '2026-10-01T00:00:00Z',
            },
            {
              id: 'p-fresh', name: 'Corn', recipe_id: null,
              section_id: null, on_list: false,
              updated_at: '2026-11-10T00:00:00Z',
            },
          ],
          error: null,
        },
      ],
    },
  });

  const result = (await run('add', { items: [{ name: 'CORN' }] }, ctx)) as {
    results: Array<Record<string, unknown>>;
  };

  assertEquals(result.results, [
    { name: 'CORN', status: 'revived', product_id: 'p-fresh', matched_name: 'Corn' },
  ]);
});

Deno.test('grocery add: recipe context probes that recipe then standalone, never a foreign recipe product', async () => {
  // Catalog: lasagna's own flour (tier 1), a standalone flour (tier
  // 2), and a DIFFERENT recipe's flour (never revived for this add).
  const catalog = {
    data: [
      {
        id: 'p-foreign', name: 'flour', recipe_id: 'r-other',
        section_id: null, on_list: false,
        updated_at: '2026-11-12T00:00:00Z',
      },
      {
        id: 'p-standalone', name: 'flour', recipe_id: null,
        section_id: 'sec-bakery', on_list: false,
        updated_at: '2026-11-11T00:00:00Z',
      },
      {
        id: 'p-lasagna', name: 'flour', recipe_id: 'r-lasagna',
        section_id: null, on_list: false,
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    error: null,
  };

  const tier1 = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      recipes: [{ data: { id: 'r-lasagna', title: 'Lasagna' }, error: null }],
      grocery_products_view: [catalog],
    },
  });
  const tier1Result = (await run(
    'add',
    { recipe_id: 'r-lasagna', items: [{ name: 'flour' }] },
    tier1.ctx,
  )) as { results: Array<Record<string, unknown>> };
  // The recipe's own product wins even though the standalone row is
  // more recently updated - tier order beats recency.
  assertEquals(tier1Result.results[0]!.product_id, 'p-lasagna');

  const tier2 = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      recipes: [{ data: { id: 'r-soup', title: 'Soup' }, error: null }],
      grocery_products_view: [catalog],
    },
  });
  const tier2Result = (await run(
    'add',
    { recipe_id: 'r-soup', items: [{ name: 'flour' }] },
    tier2.ctx,
  )) as { results: Array<Record<string, unknown>> };
  // No tier-1 match for r-soup: the standalone staple revives, and
  // the FOREIGN recipe's product - newest of all - does not.
  assertEquals(tier2Result.results[0]!.product_id, 'p-standalone');
});

Deno.test('grocery add: standalone context probes standalone first, then any product', async () => {
  const catalog = {
    data: [
      {
        id: 'p-recipe', name: 'flour', recipe_id: 'r-lasagna',
        section_id: null, on_list: false,
        updated_at: '2026-11-12T00:00:00Z',
      },
      {
        id: 'p-standalone', name: 'flour', recipe_id: null,
        section_id: null, on_list: false,
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    error: null,
  };
  const { ctx } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [catalog],
    },
  });

  const result = (await run('add', { items: [{ name: 'flour' }] }, ctx)) as {
    results: Array<Record<string, unknown>>;
  };
  // Sidebar checkbox parity: a standalone add may revive a recipe
  // product when no standalone variant exists - but standalone
  // wins when both exist, regardless of recency.
  assertEquals(result.results[0]!.product_id, 'p-standalone');
});

Deno.test('grocery add: recipe linkage defaults the note and stamps recipe_id on creates', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_sections: [SECTIONS],
      recipes: [{ data: { id: 'r-lasagna', title: 'Lasagna' }, error: null }],
      grocery_products_view: [{ data: [], error: null }],
      grocery_products: [{ data: [{ id: 'p-new' }], error: null }],
    },
  });

  await run(
    'add',
    { recipe_id: 'r-lasagna', items: [{ name: 'ricotta' }, { name: 'eggs', note: 'free-range' }] },
    ctx,
  );

  const productInserts = queryOn(queries, 'grocery_products');
  const first = callsOf(productInserts[0]!, 'insert')[0]![0] as Record<string, unknown>;
  const second = callsOf(productInserts[1]!, 'insert')[0]![0] as Record<string, unknown>;
  assertEquals(first.note, 'For Lasagna');
  assertEquals(first.recipe_id, 'r-lasagna');
  assertEquals(second.note, 'free-range');
});

Deno.test('grocery add: item validation - missing name, unknown keys, cap overruns, bad section, bad recipe', async () => {
  const base = {
    rows: {
      grocery_sections: [SECTIONS],
      grocery_products_view: [{ data: [], error: null }],
    },
  };

  await assertRejects(
    () => run('add', { items: [{ count: '2' }] }, fakeCtx(base).ctx),
    Error,
    'items[0].name is required',
  );

  await assertRejects(
    () => run('add', { items: [{ name: 'x', aisle: 3 }] }, fakeCtx(base).ctx),
    Error,
    'items[0]: unrecognized parameter: aisle',
  );

  await assertRejects(
    () =>
      run(
        'add',
        { items: Array.from({ length: 31 }, (_, i) => ({ name: `i${i}` })) },
        fakeCtx(base).ctx,
      ),
    Error,
    'items exceeds the 30-item limit (got 31)',
  );

  await assertRejects(
    () =>
      run(
        'add',
        { items: [{ name: 'x', section: 'Deli' }] },
        fakeCtx({ rows: { ...base.rows, recipes: [] } }).ctx,
      ),
    Error,
    'items[0].section "Deli" does not match one of your sections',
  );

  await assertRejects(
    () =>
      run(
        'add',
        { recipe_id: 'r-nope', items: [{ name: 'x' }] },
        fakeCtx({ rows: { ...base.rows, recipes: [{ data: null, error: null }] } }).ctx,
      ),
    Error,
    'recipe_id does not match one of your recipes',
  );
});

// --- remove -------------------------------------------------------------

Deno.test('grocery remove: by id deletes the open entry with the raced-purchase predicate', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_list_entries: [{ data: [{ id: 'e1' }], error: null }],
    },
  });

  const result = await run('remove', { id: 'p1' }, ctx);

  const del = queryOn(queries, 'grocery_list_entries')[0]!;
  assertEquals(callsOf(del, 'delete').length, 1);
  assertEquals(callsOf(del, 'eq'), [
    ['user_id', 'u-1'],
    ['product_id', 'p1'],
  ]);
  // The open-entry predicate: a purchase racing between read and
  // write must cost the delete its row, not the history its record.
  assertEquals(callsOf(del, 'is'), [['acquired_at', null]]);

  assertEquals(result, { removed: true });
});

Deno.test('grocery remove: honest combined miss for no product and for nothing open', async () => {
  const noProduct = fakeCtx({
    rows: { grocery_products: [{ data: null, error: null }] },
  });
  assertEquals(await run('remove', { id: 'p1' }, noProduct.ctx), {
    removed: false,
    reason:
      'Nothing matched an on-list item with that id or name - no such ' +
      'product, or it is not on the list.',
  });

  // Product exists but the delete matched zero rows: not on the
  // list (or a purchase won the race). Same combined reason - the
  // delete-honesty contract does not distinguish the possibilities.
  const notOpen = fakeCtx({
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_list_entries: [{ data: [], error: null }],
    },
  });
  assertEquals(await run('remove', { id: 'p1' }, notOpen.ctx), {
    removed: false,
    reason:
      'Nothing matched an on-list item with that id or name - no such ' +
      'product, or it is not on the list.',
  });
});

Deno.test('grocery remove: ambiguous name refuses with candidates; locator is id-XOR-name', async () => {
  const ambiguous = fakeCtx({
    rows: {
      grocery_products_view: [
        {
          data: [
            { id: 'a', name: 'corn', recipe_id: null, section_id: null, on_list: false, updated_at: 'x' },
            { id: 'b', name: 'Corn', recipe_id: null, section_id: null, on_list: false, updated_at: 'x' },
          ],
          error: null,
        },
      ],
    },
  });
  await assertRejects(
    () => run('remove', { name: 'CORN' }, ambiguous.ctx),
    Error,
    'matches 2 products - pass the id of the right one',
  );

  await assertRejects(
    () => run('remove', {}, fakeCtx().ctx),
    Error,
    'provide exactly one of id or name',
  );
  await assertRejects(
    () => run('remove', { id: 'p1', name: 'flour' }, fakeCtx().ctx),
    Error,
    'not both',
  );
});

// --- update -------------------------------------------------------------

function onListRow(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'p1', name: 'flour', note: null, section_id: 'sec-bakery',
      recipe_id: null, recipe_title: null, entry_id: 'e1',
      count: '1', unit: 'kg', acquired_at: null, on_list: true,
      updated_at: '2026-11-12T00:00:00Z',
      ...overrides,
    },
    error: null,
  };
}

Deno.test('grocery update: product fields patch the row; section files with auto provenance', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_products_view: [onListRow(), onListRow({ section_id: 'sec-produce' })],
      grocery_sections: [SECTIONS],
    },
  });

  const result = (await run(
    'update',
    { id: 'p1', section: 'Produce', note: 'the good one' },
    ctx,
  )) as { updated: boolean; item: Record<string, unknown> };

  const upd = queryOn(queries, 'grocery_products')[1]!;
  const patch = callsOf(upd, 'update')[0]![0] as Record<string, unknown>;
  assertEquals(patch.section_id, 'sec-produce');
  assertEquals(patch.section_source, 'auto');
  assertEquals(patch.note, 'the good one');
  assertEquals(callsOf(upd, 'eq'), [['user_id', 'u-1'], ['id', 'p1']]);

  assertEquals(result.updated, true);
  assertEquals(result.item.section, 'Produce');
});

Deno.test('grocery update: section null unfiles back to intake', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_products_view: [onListRow({ section_id: null }), onListRow({ section_id: null })],
      grocery_sections: [SECTIONS],
    },
  });

  await run('update', { id: 'p1', section: null }, ctx);

  const upd = queryOn(queries, 'grocery_products')[1]!;
  const patch = callsOf(upd, 'update')[0]![0] as Record<string, unknown>;
  assertEquals(patch.section_id, null);
  // Unfiled = classifier-eligible again, not "deliberately in
  // Other" (that UI-only state is section_id null + source 'user').
  assertEquals(patch.section_source, null);
});

Deno.test('grocery update: rename refused on recipe-linked items', async () => {
  const { ctx } = fakeCtx({
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_products_view: [onListRow({ recipe_id: 'r1', recipe_title: 'Lasagna' })],
      grocery_sections: [SECTIONS],
    },
  });

  await assertRejects(
    () => run('update', { id: 'p1', rename: '00 flour' }, ctx),
    Error,
    'rename is refused for recipe-linked items',
  );
});

Deno.test('grocery update: count/unit write the OPEN entry through the raced-purchase predicate', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_products_view: [onListRow(), onListRow({ count: '3', unit: 'kg' })],
      grocery_sections: [SECTIONS],
      grocery_list_entries: [{ data: [{ id: 'e1' }], error: null }],
    },
  });

  const result = (await run(
    'update',
    { id: 'p1', count: '3', unit: null },
    ctx,
  )) as { item: Record<string, unknown> };

  const upd = queryOn(queries, 'grocery_list_entries')[0]!;
  const patch = callsOf(upd, 'update')[0]![0] as Record<string, unknown>;
  assertEquals(patch.count, '3');
  assertEquals(patch.unit, null);
  assertEquals(callsOf(upd, 'eq'), [['user_id', 'u-1'], ['id', 'e1']]);
  assertEquals(callsOf(upd, 'is'), [['acquired_at', null]]);

  assertEquals(result.item.count, '3');
});

Deno.test('grocery update: entry fields refuse when the item is not on the list', async () => {
  const offList = fakeCtx({
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_products_view: [onListRow({ on_list: false, entry_id: 'e-closed', acquired_at: '2026-11-01T00:00:00Z' })],
      grocery_sections: [SECTIONS],
    },
  });
  // The view's entry_id points at the LATEST PURCHASE for an
  // off-list item - writing through it blindly would stamp a
  // purchase-history row. The on_list gate fires first.
  await assertRejects(
    () => run('update', { id: 'p1', count: '3' }, offList.ctx),
    Error,
    'is not on the list',
  );
  assertEquals(queryOn(offList.queries, 'grocery_list_entries').length, 0);

  // And when the gate passes but the race loses (zero rows updated),
  // the same refusal fires instead of a silent no-op.
  const raced = fakeCtx({
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_products_view: [onListRow()],
      grocery_sections: [SECTIONS],
      grocery_list_entries: [{ data: [], error: null }],
    },
  });
  await assertRejects(
    () => run('update', { id: 'p1', count: '3' }, raced.ctx),
    Error,
    'is not on the list',
  );
});

Deno.test('grocery update: empty patch and unknown section refuse', async () => {
  const base = {
    rows: {
      grocery_products: [{ data: { id: 'p1' }, error: null }],
      grocery_products_view: [onListRow()],
      grocery_sections: [SECTIONS],
    },
  };

  await assertRejects(
    () => run('update', { id: 'p1' }, fakeCtx(base).ctx),
    Error,
    'provide at least one of rename, note, section, count, or unit',
  );

  await assertRejects(
    () => run('update', { id: 'p1', section: 'Deli' }, fakeCtx(base).ctx),
    Error,
    'does not match one of your sections',
  );
});

// --- envelope -----------------------------------------------------------

Deno.test('grocery envelope: op required, unknown op refused', async () => {
  const { ctx } = fakeCtx();
  await assertRejects(
    () => grocery.execute({}, ctx),
    Error,
    'op is required (list | add | remove | update)',
  );
  await assertRejects(
    () => grocery.execute({ op: 'purchase' }, ctx),
    Error,
    'unknown op "purchase"',
  );
});
