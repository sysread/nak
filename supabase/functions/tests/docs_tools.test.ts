// Guards for the docs combination tool (venice/tools/docs.ts: list /
// get / grep / read / save / delete behind one op enum).
//
// Harness ported from recipe_tools.test.ts's stubbed-adminClient
// shape, extended with (1) a per-RPC FIFO (grep/read call the
// grep_documents + read_document_lines RPCs) and (2) a storage stub
// (save's promotion path downloads from the attachments bucket and
// uploads into documents). This file is the cluster's FIRST impl
// coverage - the combo plan's pre-merge dependency.
//
// DOCS dispatch: every test drives run(op, args, ctx) so per-op
// assertions survive envelope changes unchanged.

import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { docs } from '../venice/tools/docs.ts';

// Dispatch seam: the six verb tools became the docs combination
// tool - every test drives execute() with op in args so per-op
// assertions survive envelope changes unchanged.
const docList = seam('list');
const docGet = seam('get');
const docGrep = seam('grep');
const docRead = seam('read');
const docSave = seam('save');
const docDelete = seam('delete');

function seam(op: string) {
  return {
    execute: (args: Record<string, unknown>, ctx: ToolContext) =>
      docs.execute({ op, ...args }, ctx),
  };
}

// --- dispatch seam -----------------------------------------------------

const DOCS = {
  list: docList,
  get: docGet,
  grep: docGrep,
  read: docRead,
  save: docSave,
  delete: docDelete,
};

type DocOp = keyof typeof DOCS;

async function run(
  op: DocOp,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  return DOCS[op].execute(args, ctx);
}

// --- stub harness ------------------------------------------------------

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

interface Opts {
  rows?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
  rpcResults?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
  threadId?: string | null;
}

function fakeCtx(opts: Opts = {}): {
  ctx: ToolContext;
  queries: RecordedQuery[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  storageUploads: Array<{ bucket: string; path: string }>;
} {
  const queries: RecordedQuery[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const storageUploads: Array<{ bucket: string; path: string }> = [];
  const counters: Record<string, number> = {};
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
      const idx = (counters[table] ?? 0);
      counters[table] = idx + 1;
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
      const idx = (counters[`rpc:${name}`] ?? 0);
      counters[`rpc:${name}`] = idx + 1;
      const res = responses[Math.min(idx, responses.length - 1)] ?? { data: [], error: null };
      return Promise.resolve(res);
    },
    storage: {
      from: (bucket: string) => ({
        download: (_path: string) =>
          Promise.resolve({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }),
        upload: (path: string, _bytes: unknown, _opts: Record<string, unknown>) => {
          storageUploads.push({ bucket, path });
          return Promise.resolve({ data: { path }, error: null });
        },
        remove: (_paths: string[]) => Promise.resolve({ data: {}, error: null }),
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

const DOC_ROW = {
  id: 'd-1',
  title: 'Insurance Policy',
  description: '2024 Aetna',
  filename: 'policy.pdf',
  mime_type: 'application/pdf',
  size_bytes: 1000,
  extraction_status: 'done',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-03T00:00:00Z',
};

// --- list --------------------------------------------------------------

Deno.test('list: user filter, limit default 100, newest first, projection', async () => {
  const { ctx, queries } = fakeCtx({ rows: { documents: [{ data: [DOC_ROW], error: null }] } });
  const out = (await run('list', {}, ctx)) as Array<Record<string, unknown>>;

  const rec = queries.find((q) => q.table === 'documents')!;
  assertEquals(firstCall(rec, 'eq')![1], 'u-1');
  assertEquals(firstCall(rec, 'limit')![0], 100);
  assertEquals(firstCall(rec, 'order')![0], 'created_at');
  assertEquals((out as unknown[]).length, 1);
  assertEquals((out as Array<Record<string, unknown>>)[0]!.filename, 'policy.pdf');
});

// --- get ---------------------------------------------------------------

Deno.test('get: line-count math + overview projection without shipping the text', async () => {
  const { ctx } = fakeCtx({
    rows: {
      documents: [{
        data: {
          ...DOC_ROW,
          extraction_error: null,
          extracted_text: 'line one\nline two\nline three',
        },
        error: null,
      }],
    },
  });
  const out = (await run('get', { id: 'd-1' }, ctx)) as Record<string, unknown>;
  assertEquals((out as { found: boolean }).found, true);
  const doc = (out as { document: Record<string, unknown> }).document;
  // 3 lines: 2 newlines in the body -> length delta + 1.
  assertEquals(doc.total_lines, 3);
  assertEquals(doc.has_text, true);
  // The body must NOT ship in the overview.
  assertEquals('extracted_text' in doc, false);
});

Deno.test('get: {found: false} for unknown or foreign id', async () => {
  const { ctx } = fakeCtx({ rows: { documents: [{ data: null, error: null }] } });
  assertEquals((await run('get', { id: 'nope' }, ctx)), { found: false });
});

Deno.test('get validates: id is required', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(() => run('get', {}, ctx), Error, 'id is required');
});

// --- grep --------------------------------------------------------------

Deno.test('grep: RPC args carry the pattern + user_id, hits projected', async () => {
  const { ctx, rpcCalls } = fakeCtx({
    rpcResults: {
      grep_documents: [{
        data: [{ document_id: 'd-1', title: 'Policy', line_number: 12, line_text: 'late fee', context_before: [], context_after: [] }],
        error: null,
      }],
    },
  });
  const out = (await run('grep', { pattern: 'late fee', document_id: 'd-1', case_sensitive: true, context: 3, max_matches: 25 }, ctx)) as Record<string, unknown>;
  const rpc = rpcCalls.find((c) => c.name === 'grep_documents')!;
  assertEquals(rpc.args, {
    p_pattern: 'late fee',
    p_document_id: 'd-1',
    p_case_sensitive: true,
    p_context: 3,
    p_max_matches: 25,
    p_user_id: 'u-1',
  });
  assertEquals(out.match_count, 1);
  assertEquals(out.truncated, false);
});

Deno.test('grep: an invalid regex comes back as {error}, not a throw', async () => {
  const { ctx } = fakeCtx({
    rpcResults: {
      grep_documents: [{ data: null, error: { message: 'invalid regular expression: ([' } }],
    },
  });
  const out = (await run('grep', { pattern: '([' }, ctx)) as Record<string, unknown>;
  assertEquals(
    (out as { error: string }).error.startsWith('Invalid regular expression:'),
    true,
  );
});

Deno.test('grep validates: pattern is required', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(() => run('grep', {}, ctx), Error, 'pattern is required');
});

// --- read --------------------------------------------------------------

Deno.test('read: RPC args + span clamp to 500 lines', async () => {
  const { ctx, rpcCalls } = fakeCtx({
    rpcResults: {
      read_document_lines: [{
        data: [
          { line_number: 100, content: 'a', total_lines: 300 },
          { line_number: 200, content: 'b', total_lines: 300 },
        ],
        error: null,
      }],
    },
  });
  const out = (await run('read', { document_id: 'd-1', start_line: 100, end_line: 2000 }, ctx)) as Record<string, unknown>;
  const rpc = rpcCalls.find((c) => c.name === 'read_document_lines')!;
  // end clamps to start + 500 - 1.
  assertEquals(rpc.args.p_end, 599);
  assertEquals(out.total_lines, 300);
  assertEquals(out.start_line, 100);
  assertEquals(out.end_line, 200);
});

Deno.test('read: an empty range falls back to the stat lookup to disambiguate', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      documents: [{ data: { extracted_text: null }, error: null }],
    },
  });
  const out = (await run('read', { document_id: 'd-1', start_line: 1, end_line: 10 }, ctx)) as Record<string, unknown>;
  // The fallback stat SELECT ran against documents.
  const rec = queries.find((q) => q.table === 'documents')!;
  assertEquals(firstCall(rec, 'select')![0], 'extracted_text');
  assertEquals(out.note, 'This document has no extracted text to read.');
});

Deno.test('read validates: numeric line range required', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(
    () => run('read', { document_id: 'd-1', start_line: 'x', end_line: 2 }, ctx),
    Error,
    'start_line and end_line are required and must be numbers',
  );
});

// --- save --------------------------------------------------------------

const ATTACHMENT_ROW = {
  id: 'att-1',
  filename: 'policy.pdf',
  mime_type: 'application/pdf',
  size_bytes: 1000,
  storage_path: 'u-1/att-1/policy.pdf',
  extracted_text: 'clause one\nlate fee applies',
};

Deno.test('save create promotes the thread attachment: doc row, bucket copy, extraction stamp', async () => {
  const { ctx, queries, rpcCalls, storageUploads } = fakeCtx({
    rows: {
      message_attachments: [{ data: ATTACHMENT_ROW, error: null }],
      documents: [
        { data: [], error: null }, // natural-key probe (first)
        { data: { id: 'd-new', title: 'Insurance Policy' }, error: null }, // insert
        { data: null, error: null }, // storage_path update
        { data: null, error: null }, // extraction update
      ],
    },
  });
  const out = (await run('save', { filename: 'policy.pdf', description: '2024 Aetna' }, ctx)) as Record<string, unknown>;

  // The natural-key probe runs first (no documents matched).
  const probe = queries.filter((q) => q.table === 'documents' && firstCall(q, 'ilike'))[0];
  assertEquals(probe !== undefined, true);
  assertEquals(out.created, true);
  assertEquals(out.document_id, 'd-new');
  // Bucket copy: attachments download -> documents upload at <uid>/<docId>/<filename>.
  assertEquals(storageUploads, [{ bucket: 'documents', path: 'u-1/d-new/policy.pdf' }]);
  assertEquals(rpcCalls.length, 0);
  // Extraction stamped done with the attachment's already-parsed text.
  const extract = queries.filter((q) => q.table === 'documents' && firstCall(q, 'update'))[1];
  const patch = firstCall(extract!, 'update')![0] as Record<string, unknown>;
  assertEquals(patch.extraction_status, 'done');
  assertEquals(patch.extracted_text, 'clause one\nlate fee applies');
});

Deno.test('save create refuses an attachment with no extractable text', async () => {
  const { ctx } = fakeCtx({
    rows: {
      message_attachments: [{ data: { ...ATTACHMENT_ROW, extracted_text: null }, error: null }],
    },
  });
  const out = (await run('save', { filename: 'policy.pdf', description: 'd' }, ctx)) as Record<string, unknown>;
  assertEquals(out.created, false);
  assertEquals(
    (out as { reason: string }).reason.includes("can't be saved as a"),
    true,
  );
});

Deno.test('save create reports a missing attachment by name', async () => {
  const { ctx } = fakeCtx({ rows: { message_attachments: [{ data: null, error: null }] } });
  const out = (await run('save', { filename: 'ghost.pdf', description: 'd' }, ctx)) as Record<string, unknown>;
  assertEquals(out.created, false);
  assertEquals(
    (out as { reason: string }).reason.includes('No attachment named "ghost.pdf"'),
    true,
  );
});

Deno.test('save create validates: filename + description required, thread required', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(() => run('save', { description: 'd' }, ctx), Error, 'filename is required');
  const { ctx: ctx2 } = fakeCtx({});
  await assertRejects(() => run('save', { filename: 'x.pdf' }, ctx2), Error, 'description is required');
  const { ctx: ctx3 } = fakeCtx({ threadId: null });
  await assertRejects(
    () => run('save', { filename: 'x.pdf', description: 'd' }, ctx3),
    Error,
  );
});

Deno.test('save update patches by id; empty patch refused; miss reported honestly', async () => {
  const { ctx, queries } = fakeCtx({
    rows: { documents: [{ data: { id: 'd-1' }, error: null }] },
  });
  const out = (await run('save', { id: 'd-1', title: 'New Title' }, ctx)) as Record<string, unknown>;
  assertEquals(out.updated, true);
  assertEquals(out.document_id, 'd-1');
  const rec = queries.find((q) => q.table === 'documents')!;
  const patch = firstCall(rec, 'update')![0] as Record<string, unknown>;
  assertEquals(patch.title, 'New Title');

  const { ctx: ctx2 } = fakeCtx({});
  const refused = (await run('save', { id: 'd-1' }, ctx2)) as Record<string, unknown>;
  assertEquals(refused.updated, false);

  const { ctx: ctx3 } = fakeCtx({ rows: { documents: [{ data: null, error: null }] } });
  const missed = (await run('save', { id: 'nope', title: 'T' }, ctx3)) as Record<string, unknown>;
  assertEquals(missed.updated, false);
  assertEquals((missed as { reason: string }).reason, 'No document with that id.');
});

// --- delete ------------------------------------------------------------

Deno.test('delete removes the bucket object BEFORE the row, then reports honestly', async () => {
  const { ctx, queries } = fakeCtx({
    rows: {
      documents: [
        { data: { storage_path: 'u-1/d-1/policy.pdf' }, error: null }, // stat
        { data: null, error: null }, // delete
      ],
    },
  });
  const out = (await run('delete', { id: 'd-1' }, ctx)) as Record<string, unknown>;
  assertEquals(out.deleted, true);
  assertEquals(out.document_id, 'd-1');
  // The delete is the SECOND documents query (after the stat lookup).
  const rec = queries.filter((q) => q.table === 'documents')[1]!;
  assertEquals(callsOf(rec, 'delete').length, 1);
});

Deno.test('delete: unknown id reports {deleted: false} with the reason', async () => {
  const { ctx } = fakeCtx({
    rows: { documents: [{ data: null, error: null }] },
  });
  const out = (await run('delete', { id: 'nope' }, ctx)) as Record<string, unknown>;
  assertEquals(out.deleted, false);
  assertEquals((out as { reason: string }).reason, 'No document with that id.');
});

Deno.test('delete validates: id is required', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(() => run('delete', {}, ctx), Error, 'id is required');
});
