// Guards for the followups combination tool (venice/tools/followups.ts:
// list / save / close / dismiss behind one op enum).
//
// Harness ported from recipe_tools.test.ts's stubbed-adminClient
// shape. This file is the cluster's FIRST impl coverage - the combo
// plan's pre-merge dependency (no test imported any followup_* tool
// before the conversion).
//
// FOLLOWUPS dispatch: every test drives run(op, args, ctx) so per-op
// assertions survive envelope changes unchanged.
//
// The load-bearing pins: (1) the reschedule ledger reset - a
// relevant_after change nulls last_surfaced_at + zeroes surface_count
// (the moved plan has not been nagged about yet) while a
// question/context-only reword keeps the ledger; (2) the open-only
// guard - close/dismiss/revise all filter status='open', so a
// double-close reads as not-found rather than rewriting a recorded
// resolution; (3) the dismissed twin blocks re-forming the question.

import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { followups } from '../venice/tools/followups.ts';

// --- dispatch seam -----------------------------------------------------

type FollowupOp = 'list' | 'save' | 'close' | 'dismiss';

async function run(
  op: FollowupOp,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  return followups.execute({ op, ...args }, ctx);
}

// --- stub harness ------------------------------------------------------

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

interface Opts {
  rows?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
}

function fakeCtx(opts: Opts = {}): {
  ctx: ToolContext;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const counters: Record<string, number> = {};
  const methods = [
    'eq', 'neq', 'lt', 'lte', 'gte', 'in', 'like', 'ilike', 'contains',
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

const SAVED_ROW = {
  id: 'fu-1',
  question: 'Ask how the lasagna turned out',
  context: 'Planned a ricotta lasagna for Saturday dinner',
  status: 'open',
  relevant_after: '2026-11-09T00:00:00.000Z',
  created_at: '2026-11-03T00:00:00Z',
};

// --- list --------------------------------------------------------------

Deno.test('list: two parallel reads (open newest-first cap 50; closed window 20)', async () => {
  const open = { id: 'fu-1', question: 'q', status: 'open', relevant_after: null, surface_count: 0, created_at: 'x' };
  const closed = { id: 'fu-2', question: 'q2', status: 'answered', resolution: 'fine', updated_at: 'y' };
  const { ctx, queries } = fakeCtx({
    rows: {
      followups: [
        { data: [open], error: null }, // open read
        { data: [closed], error: null }, // closed read
      ],
    },
  });
  const out = (await run('list', {}, ctx)) as Record<string, unknown>;

  assertEquals(queries.length, 2);
  const openRec = queries[0]!;
  assertEquals(firstCall(openRec, 'eq')![1], 'u-1');
  assertEquals(callsOf(openRec, 'eq')[1]![1], 'open');
  assertEquals(firstCall(openRec, 'limit')![0], 50);
  const closedRec = queries[1]!;
  assertEquals(firstCall(closedRec, 'in')![1], ['answered', 'dismissed', 'expired']);
  assertEquals(firstCall(closedRec, 'limit')![0], 20);
  assertEquals((out as { open: unknown[] }).open.length, 1);
  assertEquals((out as { recently_closed: unknown[] }).recently_closed.length, 1);
});

Deno.test('list: a read failure on either leg fails the call', async () => {
  const { ctx } = fakeCtx({
    rows: {
      followups: [
        { data: null, error: { message: 'boom' } },
        { data: [], error: null },
      ],
    },
  });
  await assertRejects(() => run('list', {}, ctx), Error, 'followup_list failed: boom');
});

// --- save: create ------------------------------------------------------

Deno.test('save create: user + thread stamped, question required', async () => {
  const { ctx, queries } = fakeCtx({
    rows: { followups: [{ data: SAVED_ROW, error: null }] },
  });
  const out = (await run('save', { question: 'Ask how the lasagna turned out', context: 'Saturday dinner' }, ctx)) as Record<string, unknown>;

  const rec = queries.find((q) => q.table === 'followups')!;
  const insert = firstCall(rec, 'insert')![0] as Record<string, unknown>;
  assertEquals(insert.user_id, 'u-1');
  assertEquals(insert.source_thread_id, 't-1');
  assertEquals(insert.question, 'Ask how the lasagna turned out');
  assertEquals(out, SAVED_ROW);
});

Deno.test('save create: relevant_after parses to ISO; a bare date is UTC midnight', async () => {
  const { ctx, queries } = fakeCtx({
    rows: { followups: [{ data: SAVED_ROW, error: null }] },
  });
  await run('save', { question: 'q', relevant_after: '2026-07-06' }, ctx);
  const rec = queries.find((q) => q.table === 'followups')!;
  const insert = firstCall(rec, 'insert')![0] as Record<string, unknown>;
  assertEquals(insert.relevant_after, '2026-07-06T00:00:00.000Z');
});

Deno.test('save create: an unparseable relevant_after is refused with the ISO hint', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(
    () => run('save', { question: 'q', relevant_after: 'next tuesday-ish' }, ctx),
    Error,
    'relevant_after must be an ISO date or timestamp',
  );
});

Deno.test('save create: question is the only required field - missing it is named', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(
    () => run('save', { context: 'no question' }, ctx),
    Error,
    'missing required field for creating: question',
  );
});

// --- save: revise ------------------------------------------------------

Deno.test('save revise: a relevant_after change RESETS the surfacing ledger', async () => {
  const { ctx, queries } = fakeCtx({
    rows: { followups: [{ data: SAVED_ROW, error: null }] },
  });
  await run('save', { id: 'fu-1', relevant_after: '2026-11-20' }, ctx);
  const rec = queries.find((q) => q.table === 'followups')!;
  const patch = firstCall(rec, 'update')![0] as Record<string, unknown>;
  assertEquals(patch.relevant_after, '2026-11-20T00:00:00.000Z');
  // The moved plan has not been nagged about yet.
  assertEquals(patch.last_surfaced_at, null);
  assertEquals(patch.surface_count, 0);
});

Deno.test('save revise: a reword-only patch KEEPS the surfacing ledger', async () => {
  const { ctx, queries } = fakeCtx({
    rows: { followups: [{ data: SAVED_ROW, error: null }] },
  });
  await run('save', { id: 'fu-1', question: 'Ask how the lasagna went' }, ctx);
  const rec = queries.find((q) => q.table === 'followups')!;
  const patch = firstCall(rec, 'update')![0] as Record<string, unknown>;
  assertEquals('relevant_after' in patch, false);
  assertEquals('last_surfaced_at' in patch, false);
  assertEquals('surface_count' in patch, false);
});

Deno.test('save revise: only OPEN follow-ups are revisable - a closed loop reads as not-found', async () => {
  const { ctx } = fakeCtx({ rows: { followups: [{ data: null, error: null }] } });
  await assertRejects(
    () => run('save', { id: 'fu-1', question: 'q' }, ctx),
    Error,
    'followup not found or not open',
  );
});

Deno.test('save revise: an empty patch is refused, dependent on no other error', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(
    () => run('save', { id: 'fu-1' }, ctx),
    Error,
    'provide at least one of question, context, or relevant_after',
  );
});

// --- close -------------------------------------------------------------

Deno.test('close: id + resolution required, status=open guard, audit stamp', async () => {
  const { ctx, queries } = fakeCtx({
    rows: { followups: [{ data: { id: 'fu-1', question: 'q', status: 'answered', resolution: 'fine' }, error: null }] },
  });
  const out = (await run('close', { id: 'fu-1', resolution: 'made it Saturday; too salty' }, ctx)) as Record<string, unknown>;
  const rec = queries.find((q) => q.table === 'followups')!;
  const patch = firstCall(rec, 'update')![0] as Record<string, unknown>;
  assertEquals(patch.status, 'answered');
  assertEquals(patch.resolution, 'made it Saturday; too salty');
  assertEquals(callsOf(rec, 'eq').some(([c, v]) => c === 'status' && v === 'open'), true);
  assertEquals(out.status, 'answered');
});

Deno.test('close: a double-close reads as not-found rather than rewriting the resolution', async () => {
  const { ctx } = fakeCtx({ rows: { followups: [{ data: null, error: null }] } });
  await assertRejects(
    () => run('close', { id: 'fu-1', resolution: 'again' }, ctx),
    Error,
    'followup not found or already closed',
  );
});

Deno.test('close validates: resolution required with its cap', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(() => run('close', { id: 'fu-1' }, ctx), Error, 'resolution is required');
  await assertRejects(
    () => run('close', { id: 'fu-1', resolution: 'x'.repeat(501) }, ctx),
    Error,
    'resolution exceeds',
  );
});

// --- dismiss -----------------------------------------------------------

Deno.test('dismiss: marks dismissed, open-only', async () => {
  const { ctx, queries } = fakeCtx({
    rows: { followups: [{ data: { id: 'fu-1', question: 'q', status: 'dismissed' }, error: null }] },
  });
  const out = (await run('dismiss', { id: 'fu-1' }, ctx)) as Record<string, unknown>;
  const rec = queries.find((q) => q.table === 'followups')!;
  const patch = firstCall(rec, 'update')![0] as Record<string, unknown>;
  assertEquals(patch.status, 'dismissed');
  assertEquals(out.status, 'dismissed');
});

Deno.test('dismiss: not-found passes through honestly', async () => {
  const { ctx } = fakeCtx({ rows: { followups: [{ data: null, error: null }] } });
  await assertRejects(
    () => run('dismiss', { id: 'nope' }, ctx),
    Error,
    'followup not found or not open',
  );
});

// --- combo envelope ----------------------------------------------------

Deno.test('combo rejects a missing or unknown op', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(() => followups.execute({}, ctx), Error, 'op is required');
  await assertRejects(
    () => followups.execute({ op: 'snooze' }, ctx),
    Error,
    'unknown op "snooze"',
  );
});
