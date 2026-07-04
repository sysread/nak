// Offline coverage for the follow-up gather arm's timing contract
// (docs/dev/followups.md): the date-due pull selects and expires but
// does NOT consume ask budget; the ledger stamps only via
// stampFollowupLedger, which the pipeline calls after a non-empty note
// ships. A scripted admin client records every write so the tests can
// assert what was (and was not) touched.
import { assertEquals } from '@std/assert';
import { __test } from '../venice/priming/context-recall.ts';
import type { RunContextRecallOptions } from '../venice/priming/context-recall.ts';

const { gatherFollowups, stampFollowupLedger } = __test;

const NOW = Date.parse('2026-07-04T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

interface RecordedUpdate {
  patch: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

// Minimal thenable query-builder fake: every chain method records its
// filter and returns the builder; awaiting resolves select chains with
// the scripted rows and update chains with {error: null}. Shape-only -
// it does not evaluate filters (the SQL semantics are the RPC's job);
// the tests assert on which writes were issued, not on Postgres
// behavior.
function fakeAdmin(scriptedDueRows: unknown[], scriptedRpcRows: unknown[]) {
  const updates: RecordedUpdate[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  function builder(kind: 'select' | 'update', patch?: Record<string, unknown>) {
    const filters: Array<[string, unknown]> = [];
    const b = {
      eq(col: string, v: unknown) {
        filters.push([col, v]);
        return b;
      },
      in(col: string, v: unknown) {
        filters.push([col, v]);
        return b;
      },
      not(col: string, op: string, v: unknown) {
        filters.push([`${col} not ${op}`, v]);
        return b;
      },
      lte(col: string, v: unknown) {
        filters.push([`${col} lte`, v]);
        return b;
      },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: any) => unknown) {
        if (kind === 'update') {
          updates.push({ patch: patch ?? {}, filters });
          return Promise.resolve({ error: null }).then(resolve);
        }
        return Promise.resolve({ data: scriptedDueRows, error: null }).then(resolve);
      },
    };
    return b;
  }

  const admin = {
    from(_table: string) {
      return {
        select: (_cols: string) => builder('select'),
        update: (patch: Record<string, unknown>) => builder('update', patch),
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: scriptedRpcRows, error: null });
    },
  };
  return { admin, updates, rpcCalls };
}

const noopLog = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
};

function gatherOpts(admin: unknown): RunContextRecallOptions {
  return {
    admin,
    userId: 'user-1',
    nowMs: NOW,
    log: noopLog,
  } as unknown as RunContextRecallOptions;
}

function dueRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    question: `Ask about ${id}`,
    context: '',
    relevant_after: new Date(NOW - DAY).toISOString(),
    last_surfaced_at: null,
    surface_count: 0,
    ...overrides,
  };
}

Deno.test('gatherFollowups surfaces due rows proactive without touching the ask ledger', async () => {
  const { admin, updates } = fakeAdmin([dueRow('f1')], []);
  const out = await gatherFollowups(gatherOpts(admin), null);
  assertEquals(
    out.map((f) => [f.id, f.state, f.proactive]),
    [['f1', 'pending', true]],
  );
  // The timing contract: selection must not consume ask budget - no
  // ledger write, no expiry write, nothing.
  assertEquals(updates, []);
});

Deno.test('gatherFollowups flips policy-expired rows and excludes them from the index', async () => {
  const spent = dueRow('spent', { surface_count: 3 });
  const { admin, updates } = fakeAdmin([spent, dueRow('fresh')], []);
  const out = await gatherFollowups(gatherOpts(admin), null);
  assertEquals(out.map((f) => f.id), ['fresh']);
  assertEquals(updates.length, 1);
  assertEquals(updates[0].patch.status, 'expired');
  assertEquals(updates[0].filters[0], ['id', ['spent']]);
});

Deno.test('gatherFollowups unions semantic hits, deduped, with computed state', async () => {
  const semantic = [
    // Also in the due set - the proactive copy wins the dedup.
    { id: 'f1', question: 'Ask about f1', context: '', relevant_after: new Date(NOW - DAY).toISOString() },
    // Future-dated: semantically surfaced but renders as upcoming.
    { id: 'f2', question: 'Ask about f2', context: '', relevant_after: new Date(NOW + DAY).toISOString() },
    // Undated: outcome unknown.
    { id: 'f3', question: 'Ask about f3', context: '', relevant_after: null },
  ];
  const { admin, rpcCalls } = fakeAdmin([dueRow('f1')], semantic);
  const out = await gatherFollowups(gatherOpts(admin), [0.1, 0.2]);
  assertEquals(rpcCalls[0].fn, 'search_followups_by_embedding');
  assertEquals(
    out.map((f) => [f.id, f.state, f.proactive]),
    [
      ['f1', 'pending', true],
      ['f2', 'upcoming', false],
      ['f3', 'pending', false],
    ],
  );
});

Deno.test('gatherFollowups skips the semantic RPC without an embedding', async () => {
  const { admin, rpcCalls } = fakeAdmin([], []);
  const out = await gatherFollowups(gatherOpts(admin), null);
  assertEquals(out, []);
  assertEquals(rpcCalls, []);
});

Deno.test('stampFollowupLedger increments only proactive rows', async () => {
  const { admin, updates } = fakeAdmin([], []);
  await stampFollowupLedger(gatherOpts(admin), [
    { id: 'f1', question: 'q', context: '', state: 'pending', proactive: true, surface_count: 2 },
    { id: 'f2', question: 'q', context: '', state: 'pending', proactive: false, surface_count: 0 },
  ]);
  assertEquals(updates.length, 1);
  assertEquals(updates[0].patch.surface_count, 3);
  assertEquals(updates[0].patch.last_surfaced_at, new Date(NOW).toISOString());
  assertEquals(updates[0].filters, [
    ['id', 'f1'],
    ['user_id', 'user-1'],
  ]);
});

Deno.test('stampFollowupLedger is a no-op with nothing proactive', async () => {
  const { admin, updates } = fakeAdmin([], []);
  await stampFollowupLedger(gatherOpts(admin), [
    { id: 'f2', question: 'q', context: '', state: 'upcoming', proactive: false, surface_count: 0 },
  ]);
  assertEquals(updates, []);
});
