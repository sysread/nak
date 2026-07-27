// Unit coverage for the memory_consolidate tool port: surface
// validation (required fields, self-merge rejection, the data cap)
// and the RPC dispatch shape - the b-strict p_user_id must ride every
// consolidate call because the admin client bypasses RLS and the
// RPC's ownership checks are the whole guarantee. Port of the
// validation half of the deleted browser suite
// (tests/memory-consolidate-tool.test.ts); the toolbox-composition
// half lives in memory_librarian.test.ts.

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { memoryConsolidate } from '../venice/tools/memory_consolidate.ts';
import type { ToolContext } from '../venice/performToolCall.ts';

function makeCtx(
  rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
  // Existing `data` bodies of the two merge inputs, as the length-budget
  // read would see them. Default empty: no row grants headroom, so the
  // budget lands on the flat MAX_MEMORY_DATA_CHARS ceiling.
  existingBodies: string[] = [],
): {
  ctx: ToolContext;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  inserted: Array<Record<string, unknown>>;
} {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const adminClient = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpc(name, args));
    },
    from: (table: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'update', 'in']) c[m] = () => c;
      c.insert = (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        return Promise.resolve({ data: null, error: null });
      };
      c.maybeSingle = () =>
        Promise.resolve({ data: { label: 'Loser label' }, error: null });
      // Thenable so the length-budget read (which awaits the builder
      // chain directly rather than calling a terminal method) resolves to
      // a PostgREST-shaped result.
      c.then = (
        resolve: (v: { data: unknown; error: null }) => unknown,
      ) => resolve({ data: existingBodies.map((d) => ({ data: d })), error: null });
      return c;
    },
  } as unknown as SupabaseClient;
  return {
    ctx: {
      adminClient,
      userId: 'u-1',
      threadId: '',
      signal: new AbortController().signal,
      depth: 0,
    } as ToolContext,
    rpcCalls,
    inserted,
  };
}

const okRpc = () => ({ data: 4.5, error: null });

Deno.test('consolidate: rejects self-merge and missing fields before any RPC', async () => {
  const { ctx, rpcCalls } = makeCtx(okRpc);
  await assertRejects(
    () => memoryConsolidate.execute({ survivor_id: 'a', loser_id: 'a', label: 'x', data: 'y' }, ctx),
    Error,
    'must differ',
  );
  await assertRejects(
    () => memoryConsolidate.execute({ loser_id: 'b', label: 'x', data: 'y' }, ctx),
    Error,
    'survivor_id is required',
  );
  await assertRejects(
    () => memoryConsolidate.execute({ survivor_id: 'a', loser_id: 'b', data: 'y' }, ctx),
    Error,
    'label is required',
  );
  await assertRejects(
    () => memoryConsolidate.execute({ survivor_id: 'a', loser_id: 'b', label: 'x' }, ctx),
    Error,
    'data is required',
  );
  assertEquals(rpcCalls.length, 0);
});

Deno.test('consolidate: rejects data over the flat ceiling when neither input grants headroom', async () => {
  const { ctx, rpcCalls } = makeCtx(okRpc);
  await assertRejects(
    () =>
      memoryConsolidate.execute(
        { survivor_id: 'a', loser_id: 'b', label: 'x', data: 'z'.repeat(2501) },
        ctx,
      ),
    Error,
    'over the 2500-char budget',
  );
  assertEquals(rpcCalls.length, 0);
});

// The non-growth rule, which is the whole point of the budget: a merge of
// two duplicates may be as long as the LONGER input (so a pair of legacy
// over-ceiling rows can still be collapsed) but not a character longer.
// Without this, repeated consolidation passes ratchet a body upward and
// every future recall prompt pays for it.
Deno.test('consolidate: allows a body up to the longer input, rejects past it', async () => {
  const legacy = ['y'.repeat(4000), 'y'.repeat(3000)];

  const atBudget = makeCtx(okRpc, legacy);
  await memoryConsolidate.execute(
    { survivor_id: 'a', loser_id: 'b', label: 'x', data: 'z'.repeat(4000) },
    atBudget.ctx,
  );
  assertEquals(atBudget.rpcCalls.length, 1);

  const overBudget = makeCtx(okRpc, legacy);
  await assertRejects(
    () =>
      memoryConsolidate.execute(
        { survivor_id: 'a', loser_id: 'b', label: 'x', data: 'z'.repeat(4001) },
        overBudget.ctx,
      ),
    Error,
    'over the 4000-char budget',
  );
  assertEquals(overBudget.rpcCalls.length, 0);
});

Deno.test('consolidate: dispatches the RPC with trimmed args and the b-strict user id', async () => {
  const { ctx, rpcCalls, inserted } = makeCtx(okRpc);
  const result = await memoryConsolidate.execute(
    { survivor_id: '  a  ', loser_id: ' b ', label: '  Cat  ', data: 'Mochi' },
    ctx,
  );

  assertEquals(result, { survivor_id: 'a', confidence: 4.5 });
  const call = rpcCalls.find((c) => c.name === 'consolidate_memories');
  assertEquals(call?.args, {
    p_survivor_id: 'a',
    p_loser_id: 'b',
    p_new_label: 'Cat',
    p_new_data: 'Mochi',
    p_user_id: 'u-1',
  });
  // The merge lands in the changelog as an update on the survivor,
  // phrased with the loser's snapshotted label.
  const entry = inserted.find((r) => r.table === 'memory_changelog');
  assertEquals(entry?.kind, 'update');
  assertStringIncludes(String(entry?.message), 'Merged "Loser label"');
});

Deno.test('consolidate: propagates RPC errors verbatim', async () => {
  const { ctx } = makeCtx(() => ({ data: null, error: { message: 'loser memory b is not owned by the caller' } }));
  await assertRejects(
    () =>
      memoryConsolidate.execute(
        { survivor_id: 'a', loser_id: 'b', label: 'x', data: 'y' },
        ctx,
      ),
    Error,
    'not owned by the caller',
  );
});
