// Guards for the recipe-photo combination tool (venice/tools/recipe_photos.ts).
//
// Harness ported from recipe_record_tools.test.ts's stubbed-adminClient
// shape, extended with (1) a storage stub (attach downloads conversation
// attachments and uploads into the recipe-images bucket) and (2) a
// per-RPC FIFO (attach issues recipe_image_upsert + recipe_attach_photos
// in one call, which the single rpcResult queue cannot script).
//
// PHOTOTOOLS dispatch: every test drives the combo def's execute() with
// op in args, so per-op assertions survive envelope changes unchanged.
//
// The attach op's closed contract is the load-bearing pin (commit
// a49dd52d's anti-merge rationale): resolution fails FAST with every
// problem named and no partial attach, and reorder takes a full
// permutation. Those invariants are what the combo conversion must
// not lose.

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { recipePhotos } from '../venice/tools/recipe_photos.ts';

// The dispatch seam: every test drives the combo def's execute() with
// op in args, so per-op assertions survive envelope changes unchanged.
type PhotoOp = 'attach' | 'remove' | 'reorder' | 'label';

async function run(
  op: PhotoOp,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  return recipePhotos.execute({ op, ...args }, ctx) as Promise<
    Record<string, unknown>
  >;
}

// --- stub harness ------------------------------------------------------

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

interface Ctx {
  ctx: ToolContext;
  queries: RecordedQuery[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  storageUploads: Array<{ bucket: string; path: string; opts: Record<string, unknown> }>;
}

interface Opts {
  rows?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
  rpcResults?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
  threadId?: string | null;
}

function fakeCtx(opts: Opts = {}): Ctx {
  const queries: RecordedQuery[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const storageUploads: Array<{ bucket: string; path: string; opts: Record<string, unknown> }> = [];
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
      // FIFO per TABLE (a handler issues several from() calls against
      // one table); the last scripted entry repeats.
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
      const responses = opts.rpcResults?.[name] ?? [];
      const idx = (tableCounters[`rpc:${name}`] ?? 0);
      tableCounters[`rpc:${name}`] = idx + 1;
      const res = responses[Math.min(idx, responses.length - 1)] ?? { data: [], error: null };
      return Promise.resolve(res);
    },
    storage: {
      from: (bucket: string) => ({
        // attachments download: a tiny valid blob; sha256Hex runs on the
        // bytes, so content does not matter, only that arrayBuffer works.
        download: (_path: string) =>
          Promise.resolve({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }),
        upload: (path: string, _bytes: unknown, uploadOpts: Record<string, unknown>) => {
          storageUploads.push({ bucket, path, opts: uploadOpts });
          return Promise.resolve({ data: { path }, error: null });
        },
      }),
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
    storageUploads,
  };
}

function callsOf(query: RecordedQuery, method: string): unknown[][] {
  return query.calls.filter((c) => c.method === method).map((c) => c.args);
}

function firstCall(query: RecordedQuery, method: string): unknown[] | undefined {
  return callsOf(query, method)[0];
}

// --- attach ------------------------------------------------------------

const ATTACH_ROWS = {
  message_attachments: [
    { data: { id: 'att-1', filename: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 3, storage_path: 'p/a' }, error: null },
    { data: { id: 'att-2', filename: 'b.jpg', mime_type: 'image/jpeg', size_bytes: 3, storage_path: 'p/b' }, error: null },
  ],
};

Deno.test('attach resolves by filename in-thread, uploads content-addressed, and RPCs with user_id + labels', async () => {
  const { ctx, queries, rpcCalls, storageUploads } = fakeCtx({
    rows: ATTACH_ROWS,
    rpcResults: {
      recipe_image_upsert: [{ data: 'img-1', error: null }, { data: 'img-2', error: null }],
      recipe_attach_photos: [{
        data: [
          { image_id: 'img-1', position: 0, label: 'front' },
          { image_id: 'img-2', position: 1, label: null },
        ],
        error: null,
      }],
    },
  });
  const out = await run('attach', {
    recipe_id: 'r-1',
    filenames: ['a.jpg', 'b.jpg'],
    labels: ['front', null],
    change_message: 'add photos',
  }, ctx);

  // Resolution filters to THIS thread, the exact filename, and images.
  const res1 = queries.find((q) => q.table === 'message_attachments')!;
  assertEquals(firstCall(res1, 'eq')![0], 'messages.thread_id');
  assertEquals(firstCall(res1, 'eq')![1], 't-1');
  assertEquals(callsOf(res1, 'eq')[1]![1], 'a.jpg');
  assertEquals(firstCall(res1, 'like')![1], 'image/%');

  // Content-addressed upload path: <userId>/<sha256> into recipe-images.
  assertEquals(storageUploads.length, 2);
  assertEquals(storageUploads[0]!.bucket, 'recipe-images');
  assertEquals(storageUploads[0]!.path, 'u-1/039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  assertEquals(storageUploads[0]!.opts.contentType, 'image/jpeg');
  assertEquals(storageUploads[0]!.opts.upsert, true);

  // b-strict: p_user_id stamped on both RPCs.
  const upsert1 = rpcCalls.find((c) => c.name === 'recipe_image_upsert')!;
  assertEquals(upsert1.args.p_user_id, 'u-1');
  assertEquals(upsert1.args.p_sha256, '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  const attachRpc = rpcCalls.find((c) => c.name === 'recipe_attach_photos')!;
  assertEquals(attachRpc.args.p_user_id, 'u-1');
  assertEquals(attachRpc.args.p_recipe_id, 'r-1');
  assertEquals(attachRpc.args.p_image_ids, ['img-1', 'img-2']);
  assertEquals(attachRpc.args.p_image_labels, ['front', null]);
  assertEquals(attachRpc.args.p_change_message, 'add photos');

  assertEquals(out, {
    recipe_id: 'r-1',
    photos: [
      { id: 'img-1', position: 0, label: 'front' },
      { id: 'img-2', position: 1, label: null },
    ],
  });
});

Deno.test('attach omits p_image_labels (elided form) when no labels passed', async () => {
  const { ctx, rpcCalls } = fakeCtx({
    rows: ATTACH_ROWS,
    rpcResults: {
      recipe_image_upsert: [{ data: 'img-1', error: null }, { data: 'img-2', error: null }],
      recipe_attach_photos: [{ data: [], error: null }],
    },
  });
  await run('attach', {
    recipe_id: 'r-1',
    filenames: ['a.jpg', 'b.jpg'],
    change_message: 'add photos',
  }, ctx);
  const attachRpc = rpcCalls.find((c) => c.name === 'recipe_attach_photos')!;
  assertEquals(attachRpc.args.p_image_labels, null);
});

Deno.test('attach normalizes labels: trims, empty string becomes null', async () => {
  const { ctx, rpcCalls } = fakeCtx({
    rows: ATTACH_ROWS,
    rpcResults: {
      recipe_image_upsert: [{ data: 'img-1', error: null }, { data: 'img-2', error: null }],
      recipe_attach_photos: [{ data: [], error: null }],
    },
  });
  await run('attach', {
    recipe_id: 'r-1',
    filenames: ['a.jpg', 'b.jpg'],
    labels: ['  caption  ', ''],
    change_message: 'm',
  }, ctx);
  const attachRpc = rpcCalls.find((c) => c.name === 'recipe_attach_photos')!;
  assertEquals(attachRpc.args.p_image_labels, ['caption', null]);
});

Deno.test('attach fails FAST with every missing/expired filename named and fires no RPC', async () => {
  const { ctx, rpcCalls } = fakeCtx({
    rows: {
      message_attachments: [
        { data: null, error: null }, // a.jpg: not in thread
        { data: { id: 'att-2', filename: 'b.jpg', mime_type: 'image/jpeg', size_bytes: 3, storage_path: null }, error: null }, // b.jpg: expired
      ],
    },
  });
  const err = await assertRejects(
    () => run('attach', { recipe_id: 'r-1', filenames: ['a.jpg', 'b.jpg'], change_message: 'm' }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'not in this thread: "a.jpg"');
  assertStringIncludes(err.message, 'bytes expired (re-attach to refresh): "b.jpg"');
  assertEquals(rpcCalls.length, 0);
});

Deno.test('attach validates: labels length must match filenames length', async () => {
  const { ctx } = fakeCtx({ rows: ATTACH_ROWS });
  await assertRejects(
    () => run('attach', { recipe_id: 'r-1', filenames: ['a.jpg'], labels: ['x', 'y'], change_message: 'm' }, ctx),
    Error,
    'labels length (2) must match filenames length (1)',
  );
});

Deno.test('attach validates: change_message required, filenames non-empty, thread required', async () => {
  const ctx0 = fakeCtx({ rows: ATTACH_ROWS });
  await assertRejects(
    () => run('attach', { recipe_id: 'r-1', filenames: ['a.jpg'], change_message: '  ' }, ctx0.ctx),
    Error,
    'change_message is required',
  );
  const ctx1 = fakeCtx({ rows: ATTACH_ROWS });
  await assertRejects(
    () => run('attach', { recipe_id: 'r-1', filenames: [], change_message: 'm' }, ctx1.ctx),
    Error,
    'filenames must contain at least one entry',
  );
  const ctx2 = fakeCtx({ threadId: null });
  await assertRejects(
    () => run('attach', { recipe_id: 'r-1', filenames: ['a.jpg'], change_message: 'm' }, ctx2.ctx),
    Error,
  );
});

// --- remove ------------------------------------------------------------

Deno.test('remove RPCs recipe_remove_photos with ids + user_id and projects the result', async () => {
  const { ctx, rpcCalls } = fakeCtx({
    rpcResults: {
      recipe_remove_photos: [{
        data: [{ image_id: 'img-2', position: 0, label: null }],
        error: null,
      }],
    },
  });
  const out = await run('remove', {
    recipe_id: 'r-1',
    photo_ids: ['img-1', 'img-2'],
    change_message: 'drop one',
  }, ctx);
  const rpc = rpcCalls.find((c) => c.name === 'recipe_remove_photos')!;
  assertEquals(rpc.args, {
    p_recipe_id: 'r-1',
    p_image_ids: ['img-1', 'img-2'],
    p_change_message: 'drop one',
    p_user_id: 'u-1',
  });
  assertEquals(out, { recipe_id: 'r-1', photos: [{ id: 'img-2', position: 0, label: null }] });
});

Deno.test('remove validates: photo_ids non-empty', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(
    () => run('remove', { recipe_id: 'r-1', photo_ids: [], change_message: 'm' }, ctx),
    Error,
    'photo_ids must contain at least one entry',
  );
});

// --- reorder -----------------------------------------------------------

Deno.test('reorder RPCs recipe_reorder_photos with the full permutation + user_id', async () => {
  const { ctx, rpcCalls } = fakeCtx({
    rpcResults: {
      recipe_reorder_photos: [{
        data: [
          { image_id: 'img-2', position: 0, label: null },
          { image_id: 'img-1', position: 1, label: 'front' },
        ],
        error: null,
      }],
    },
  });
  const out = await run('reorder', {
    recipe_id: 'r-1',
    photo_ids: ['img-2', 'img-1'],
    change_message: 'flip order',
  }, ctx);
  const rpc = rpcCalls.find((c) => c.name === 'recipe_reorder_photos')!;
  assertEquals(rpc.args, {
    p_recipe_id: 'r-1',
    p_image_ids: ['img-2', 'img-1'],
    p_change_message: 'flip order',
    p_user_id: 'u-1',
  });
  assertEquals(out, {
    recipe_id: 'r-1',
    photos: [
      { id: 'img-2', position: 0, label: null },
      { id: 'img-1', position: 1, label: 'front' },
    ],
  });
});

// --- label -------------------------------------------------------------

Deno.test('label parses {photo_id, label} pairs, clears via null/empty, stamps user_id', async () => {
  const { ctx, rpcCalls } = fakeCtx({
    rpcResults: {
      recipe_set_photo_labels: [{
        data: [{ image_id: 'img-1', position: 0, label: 'new caption' }],
        error: null,
      }],
    },
  });
  const out = await run('label', {
    recipe_id: 'r-1',
    labels: [
      { photo_id: 'img-1', label: '  new caption  ' },
      { photo_id: 'img-2', label: null },
      { photo_id: 'img-3', label: '' },
    ],
    change_message: 'caption',
  }, ctx);
  const rpc = rpcCalls.find((c) => c.name === 'recipe_set_photo_labels')!;
  assertEquals(rpc.args, {
    p_recipe_id: 'r-1',
    p_image_ids: ['img-1', 'img-2', 'img-3'],
    p_image_labels: ['new caption', null, null],
    p_change_message: 'caption',
    p_user_id: 'u-1',
  });
  assertEquals(out, { recipe_id: 'r-1', photos: [{ id: 'img-1', position: 0, label: 'new caption' }] });
});

Deno.test('label enforces the 200-char cap with the verbatim message', async () => {
  const { ctx } = fakeCtx({});
  const err = await assertRejects(
    () => run('label', {
      recipe_id: 'r-1',
      labels: [{ photo_id: 'img-1', label: 'x'.repeat(201) }],
      change_message: 'm',
    }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'labels[].label exceeds 200-char limit (got 201)');
});

Deno.test('label validates: entries must be objects with a non-empty photo_id', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(
    () => run('label', { recipe_id: 'r-1', labels: ['nope'], change_message: 'm' }, ctx),
    Error,
    'each labels entry must be an object with photo_id + label',
  );
  await assertRejects(
    () => run('label', { recipe_id: 'r-1', labels: [{ label: 'x' }], change_message: 'm' }, ctx),
    Error,
    'each labels entry must have a non-empty photo_id',
  );
});

// --- combo envelope ----------------------------------------------------

Deno.test('combo rejects a missing or unknown op', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(
    () => recipePhotos.execute({ recipe_id: 'r-1', change_message: 'm' }, ctx),
    Error,
    'op is required',
  );
  await assertRejects(
    () =>
      recipePhotos.execute(
        { op: 'shuffle', recipe_id: 'r-1', change_message: 'm' },
        ctx,
      ),
    Error,
    'unknown op "shuffle"',
  );
});

// --- RPC failure propagation ------------------------------------------

Deno.test('remove propagates RPC failure with the RPC named', async () => {
  const { ctx } = fakeCtx({
    rpcResults: {
      recipe_remove_photos: [{ data: null, error: { message: 'boom' } }],
    },
  });
  await assertRejects(
    () => run('remove', { recipe_id: 'r-1', photo_ids: ['img-1'], change_message: 'm' }, ctx),
    Error,
    'recipe_remove_photos failed: boom',
  );
});
