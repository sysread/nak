// Guards for the tool-batch resilience changes (getStreamingResponse):
// the per-round dispatch cap, the deferred outcome shape, per-call
// result-row persistence, and the ask_user sibling-cancel content.
//
// Harness modeled on recipe_record_tools.test.ts's stubbed-adminClient
// shape. The round loop itself is inline in the orchestrator (no test
// harness exists for it); these tests pin the exported pieces it
// composes - the split, the deferral, the row insert, the sibling
// encoding - so the glue stays thin and the contracts stay pinned.
//
// The delete-tool half pins the honest result shapes: a zero-row
// delete reports {deleted: false, reason} instead of a silent success
// (the 2026-10-13 prod incident: re-issued deletes after an
// interrupted batch could not tell "already gone" from "deleted"), and
// a zero-row delete writes no changelog row.

import { assertEquals, assertStringIncludes } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolCallRequest } from '../_shared/venice-stream.ts';
import {
  askUserRowContent,
  DEFERRED_TOOL_MESSAGE,
  deferredToolOutcome,
  persistOneToolResult,
  splitByDispatchCap,
} from '../venice/getStreamingResponse.ts';
import { memoryDelete } from '../venice/tools/memory_delete.ts';
import { wikiDelete } from '../venice/tools/wiki_delete.ts';
import { recipeDelete } from '../venice/tools/recipe_delete.ts';
import { recordDelete } from '../venice/tools/record_delete.ts';
import { recipeRecordDelete } from '../venice/tools/recipe_record_delete.ts';
import { recordLinkDelete } from '../venice/tools/record_link_delete.ts';

// --- stub harness ------------------------------------------------------

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface RecordedQuery {
  table: string;
  calls: RecordedCall[];
}

interface Opts {
  // Per-table FIFO of awaited responses; the last entry repeats when
  // the table is awaited more often than scripted.
  rows?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
}

function fakeClient(opts: Opts = {}): {
  adminClient: SupabaseClient;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
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
  } as unknown as SupabaseClient;
  return { adminClient, queries };
}

function callsOf(query: RecordedQuery | undefined, method: string): unknown[][] {
  return (query?.calls ?? []).filter((c) => c.method === method).map((c) => c.args);
}

// --- dispatch cap ------------------------------------------------------

function fakeRequest(i: number, name = 'memory_delete'): ToolCallRequest {
  return { id: `call-${i}`, name, args: { id: `x-${i}` } };
}

Deno.test('splitByDispatchCap keeps the head of 10 and defers the tail, in model order', () => {
  const calls = Array.from({ length: 19 }, (_, i) => fakeRequest(i));
  const { dispatchable, deferred } = splitByDispatchCap(calls);
  assertEquals(dispatchable.length, 10);
  assertEquals(deferred.length, 9);
  // Model order is dispatch priority: the head is calls 0-9.
  assertEquals(dispatchable[0].id, 'call-0');
  assertEquals(dispatchable[9].id, 'call-9');
  assertEquals(deferred[0].id, 'call-10');
  assertEquals(deferred[8].id, 'call-18');
});

Deno.test('splitByDispatchCap passes a batch at or under the cap through untouched', () => {
  const calls = Array.from({ length: 10 }, (_, i) => fakeRequest(i));
  const { dispatchable, deferred } = splitByDispatchCap(calls);
  assertEquals(dispatchable.length, 10);
  assertEquals(deferred.length, 0);
  const one = [fakeRequest(0)];
  assertEquals(splitByDispatchCap(one).deferred.length, 0);
  assertEquals(splitByDispatchCap([]).dispatchable.length, 0);
});

// --- deferred outcome --------------------------------------------------

Deno.test('deferredToolOutcome is an error-shaped outcome with the re-issue teaching text', () => {
  const o = deferredToolOutcome(fakeRequest(3));
  assertEquals(o.ok, false);
  assertEquals(o.deferred, true);
  assertEquals(o.errorMessage, DEFERRED_TOOL_MESSAGE);
  // The result carries the same text so either encoding path shows it.
  assertEquals((o.result as { error: string }).error, DEFERRED_TOOL_MESSAGE);
  // Re-issue wording, not failure wording - the model must retry, not
  // apologize.
  assertStringIncludes(DEFERRED_TOOL_MESSAGE, 'Not executed');
  assertStringIncludes(DEFERRED_TOOL_MESSAGE, 'Re-issue this call');
  // Under the 200-char tool_call_response summary slice so the
  // transient card carries it intact.
  assertEquals(DEFERRED_TOOL_MESSAGE.length <= 200, true);
});

// --- per-call row persistence ------------------------------------------

Deno.test('persistOneToolResult inserts role=tool with thread, call id, name, content', async () => {
  const { adminClient, queries } = fakeClient({
    rows: { messages: [{ data: { id: 'row-1' }, error: null }] },
  });
  const req = fakeRequest(0, 'record_delete');
  const row = await persistOneToolResult(adminClient, 'thread-1', req, '{"ok":true}');
  assertEquals(row.id, 'row-1');
  assertEquals(row.tool_call_id, 'call-0');
  assertEquals(row.name, 'record_delete');
  assertEquals(row.content, '{"ok":true}');
  const insert = callsOf(queries.find((q) => q.table === 'messages'), 'insert')[0][0] as Record<string, unknown>;
  assertEquals(insert.thread_id, 'thread-1');
  assertEquals(insert.role, 'tool');
  assertEquals(insert.tool_call_id, 'call-0');
  assertEquals(insert.name, 'record_delete');
  assertEquals(insert.content, '{"ok":true}');
});

Deno.test('persistOneToolResult throws on insert failure - a fan-in hole 400s the next round', async () => {
  const { adminClient } = fakeClient({
    rows: { messages: [{ data: null, error: { message: 'boom' } }] },
  });
  let caught = '';
  try {
    await persistOneToolResult(adminClient, 'thread-1', fakeRequest(0), '{}');
  } catch (err) {
    caught = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(caught, 'boom');
});

// --- ask_user sibling-cancel content -----------------------------------

Deno.test('askUserRowContent carries the sentinel verbatim for the suspend row', () => {
  const sentinel = { __ask_user_pending__: true, question: 'which one?' };
  const o = { request: fakeRequest(0), ok: true, result: sentinel, errorMessage: '' };
  assertEquals(askUserRowContent(o, true), JSON.stringify(sentinel));
});

Deno.test('askUserRowContent pre-cancels sibling ask_user rows', () => {
  const o = { request: fakeRequest(0), ok: true, result: { __ask_user_pending__: true }, errorMessage: '' };
  assertEquals(
    askUserRowContent(o, false),
    JSON.stringify({
      __ask_user_answered__: true,
      via: 'cancelled_by_sibling_ask_user',
      answer: null,
    }),
  );
});

// --- honest delete results ---------------------------------------------

Deno.test('memory_delete reports {deleted: false, reason} and writes no changelog on a zero-row match', async () => {
  const { adminClient, queries } = fakeClient({
    rows: {
      memories: [
        { data: null, error: null }, // existence read: nothing there
        { data: [], error: null }, // delete matched zero rows
      ],
    },
  });
  const res = await memoryDelete.execute(
    { id: 'm-1', message: 'cleanup' },
    ctxOf(adminClient),
  ) as Record<string, unknown>;
  assertEquals(res.deleted, false);
  assertStringIncludes(String(res.reason), 'already deleted');
  // No changelog row for a delete that removed nothing.
  assertEquals(queries.some((q) => q.table === 'memory_changelog'), false);
});

Deno.test('memory_delete returns {deleted: true} and appends the changelog on a real delete', async () => {
  const { adminClient, queries } = fakeClient({
    rows: {
      memories: [
        { data: { label: 'Old label', data: 'body' }, error: null },
        { data: [{ id: 'm-1' }], error: null }, // delete matched one row
      ],
    },
  });
  const res = await memoryDelete.execute(
    { id: 'm-1', message: 'cleanup' },
    ctxOf(adminClient),
  ) as Record<string, unknown>;
  assertEquals(res.deleted, true);
  const change = callsOf(queries.find((q) => q.table === 'memory_changelog'), 'insert')[0][0] as Record<string, unknown>;
  assertEquals(change.kind, 'delete');
  assertEquals(change.label_at_change, 'Old label');
});

Deno.test('wiki_delete keeps the id field in both shapes and skips the changelog on a zero-row match', async () => {
  const { adminClient, queries } = fakeClient({
    rows: {
      wiki_articles: [
        { data: null, error: null }, // existence read: nothing there
        { data: [], error: null }, // delete matched zero rows
      ],
    },
  });
  const res = await wikiDelete.execute(
    { id: 'w-1', message: 'cleanup' },
    ctxOf(adminClient),
  ) as Record<string, unknown>;
  assertEquals(res.id, 'w-1');
  assertEquals(res.deleted, false);
  assertStringIncludes(String(res.reason), 'already deleted');
  assertEquals(queries.some((q) => q.table === 'wiki_changelog'), false);
});

Deno.test('recipe_delete reports {deleted: false, reason} on a zero-row match', async () => {
  const { adminClient } = fakeClient({
    rows: { recipes: [{ data: [], error: null }] },
  });
  const res = await recipeDelete.execute({ id: 'r-1' }, ctxOf(adminClient)) as Record<string, unknown>;
  assertEquals(res.deleted, false);
  assertStringIncludes(String(res.reason), 'already deleted');
});

Deno.test('record_delete carries the reason on the false shape and the changelog on the true shape', async () => {
  const miss = fakeClient({
    rows: {
      wiki_records: [
        { data: null, error: null }, // existence read
        { data: [], error: null }, // delete matched zero rows
      ],
    },
  });
  const missRes = await recordDelete.execute({ id: 'rec-1' }, ctxOf(miss.adminClient)) as Record<string, unknown>;
  assertEquals(missRes.deleted, false);
  assertStringIncludes(String(missRes.reason), 'already deleted');

  const hit = fakeClient({
    rows: {
      wiki_records: [
        { data: { article_id: 'a-1', date: '2026-10-04', content: 'baked it' }, error: null },
        { data: [{ id: 'rec-1' }], error: null },
      ],
    },
  });
  const hitRes = await recordDelete.execute({ id: 'rec-1' }, ctxOf(hit.adminClient)) as Record<string, unknown>;
  assertEquals(hitRes.deleted, true);
  const change = callsOf(hit.queries.find((q) => q.table === 'wiki_changelog'), 'insert')[0][0] as Record<string, unknown> | undefined;
  // The changelog append is best-effort; pin only that a row was
  // attempted with the right kind when the delete landed.
  assertEquals(change?.['kind'], 'record_delete');
});

Deno.test('recipe_record_delete carries the reason on the false shape', async () => {
  const { adminClient } = fakeClient({
    rows: { recipe_records: [{ data: [], error: null }] },
  });
  const res = await recipeRecordDelete.execute({ id: 'rr-1' }, ctxOf(adminClient)) as Record<string, unknown>;
  assertEquals(res.deleted, false);
  assertStringIncludes(String(res.reason), 'already deleted');
});

Deno.test('record_link_delete carries the reason on the false shape', async () => {
  const { adminClient } = fakeClient({
    rows: {
      wiki_records: [
        { data: { article_id: 'a-1' }, error: null }, // from record read
        { data: { article_id: 'a-1' }, error: null }, // to record read
      ],
      wiki_record_links: [{ data: [], error: null }], // delete matched zero rows
    },
  });
  const res = await recordLinkDelete.execute(
    { from_record_id: 'r-1', to_record_id: 'r-2' },
    ctxOf(adminClient),
  ) as Record<string, unknown>;
  assertEquals(res.deleted, false);
  assertStringIncludes(String(res.reason), 'never existed or already removed');
});

// --- shared ctx builder ------------------------------------------------

function ctxOf(adminClient: SupabaseClient) {
  return {
    adminClient,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
    depth: 0,
  };
}
