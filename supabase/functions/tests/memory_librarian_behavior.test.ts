// Behavioral coverage for the rem and deep-sleep entry points, driven
// through the runner's completion seam (and deep-sleep's embed seam).
// The load-bearing semantics under test:
//
//   - rem: an agent failure leaves the conversation's hint-queue rows
//     UNPROCESSED (the next cycle retries), while a too-small batch is
//     marked processed WITHOUT spending a Venice call.
//   - deep-sleep: a lonely seed (no neighbors above the similarity
//     gate) stamps its visit and skips Venice entirely; an agent
//     failure on the sweep path leaves the batch UNVISITED so the
//     next cycle retries the same neighborhood.
//   - both: the shared in-flight guard turns collisions into clean
//     'busy'/'inflight-blocked' outcomes, and a held guard is always
//     released on the way out.

import { assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runRemManual, runRemSweepTick } from '../venice/agents/rem.ts';
import {
  __test as deepSleepTest,
  runDeepSleepSweepTick,
} from '../venice/agents/deep_sleep.ts';
import type { ToolCompletionResult } from '../venice/tools/_venice_complete.ts';

function completion(partial: Partial<ToolCompletionResult>): ToolCompletionResult {
  return {
    text: '',
    reasoning: '',
    citations: [],
    finishReason: 'stop',
    usage: null,
    toolCalls: [],
    ...partial,
  };
}

interface StubResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Minimal thenable PostgREST-builder stub (the wiki_behavior shape)
 * extended with an op log: every .update() call records its table so
 * tests can assert which bookkeeping writes did - and did NOT -
 * happen. One scripted result per table serves both the read path
 * (data) and the write path (error check).
 */
function makeAdmin(script: {
  rpc: (name: string, args: Record<string, unknown>) => StubResult;
  tables: Record<string, StubResult>;
}): {
  admin: SupabaseClient;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  updatedTables: string[];
} {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const updatedTables: string[] = [];

  function chain(table: string, result: StubResult): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gte', 'in', 'order', 'limit', 'insert', 'upsert', 'delete']) {
      c[m] = () => c;
    }
    c.update = () => {
      updatedTables.push(table);
      return c;
    };
    c.maybeSingle = () => Promise.resolve(result);
    c.single = () => Promise.resolve(result);
    c.then = (
      resolve: (v: StubResult) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return c;
  }

  const admin = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(script.rpc(name, args));
    },
    from: (table: string) =>
      chain(
        table,
        script.tables[table] ?? { data: null, error: { message: `no stub for table ${table}` } },
      ),
  } as unknown as SupabaseClient;
  return { admin, rpcCalls, updatedTables };
}

// Two-memory co-occurrence batch in the joined hint-queue row shape.
const REM_BATCH = {
  data: [
    { memory_id: 'm1', memories: { id: 'm1', label: 'cat', data: 'Mochi', confidence: 1.0 } },
    { memory_id: 'm2', memories: { id: 'm2', label: 'vet', data: 'Dr. Wu', confidence: 1.0 } },
  ],
  error: null,
};

const APP_CONFIG = { data: { venice_api_key: 'key' }, error: null };

function remRpcScript(overrides: Record<string, StubResult> = {}) {
  return (name: string): StubResult => {
    if (name in overrides) return overrides[name];
    if (name === 'claim_next_user_for_rem') return { data: 'user-1', error: null };
    if (name === 'claim_memory_librarian_inflight') return { data: true, error: null };
    if (name === 'pick_rem_eligible_conversations') {
      return { data: [{ conversation_id: 'c1' }], error: null };
    }
    return { data: null, error: null };
  };
}

Deno.test('rem sweep: happy path marks the conversation processed and releases the guard', async () => {
  const { admin, rpcCalls, updatedTables } = makeAdmin({
    rpc: remRpcScript(),
    tables: { memory_conversation: REM_BATCH, app_config: APP_CONFIG },
  });

  const summary = await runRemSweepTick(admin, {
    // deno-lint-ignore require-await
    complete: async () => completion({ text: 'No changes - already related.' }),
  });

  assertEquals(summary.outcome, 'reviewed');
  assertEquals(summary.conversationsProcessed, 1);
  assertEquals(updatedTables.includes('memory_conversation'), true);
  assertEquals(
    rpcCalls.some((c) => c.name === 'release_memory_librarian_inflight'),
    true,
  );
});

Deno.test('rem sweep: an agent failure leaves the hint-queue rows unprocessed', async () => {
  const { admin, rpcCalls, updatedTables } = makeAdmin({
    rpc: remRpcScript(),
    tables: { memory_conversation: REM_BATCH, app_config: APP_CONFIG },
  });

  const summary = await runRemSweepTick(admin, {
    // deno-lint-ignore require-await
    complete: async () => {
      throw new Error('Venice chat/completions 500: gateway error');
    },
  });

  // A failed conversation contributes nothing processed; critically,
  // memory_conversation was never stamped, so the next cycle retries.
  assertEquals(summary.outcome, 'empty-queue');
  assertEquals(updatedTables.includes('memory_conversation'), false);
  // The guard still releases on the error path.
  assertEquals(
    rpcCalls.some((c) => c.name === 'release_memory_librarian_inflight'),
    true,
  );
});

Deno.test('rem sweep: a too-small batch is marked processed without reaching Venice', async () => {
  let completeCalls = 0;
  const oneRow = {
    data: [
      { memory_id: 'm1', memories: { id: 'm1', label: 'cat', data: 'Mochi', confidence: 1.0 } },
    ],
    error: null,
  };
  const { admin, updatedTables } = makeAdmin({
    rpc: remRpcScript(),
    tables: { memory_conversation: oneRow, app_config: APP_CONFIG },
  });

  const summary = await runRemSweepTick(admin, {
    // deno-lint-ignore require-await
    complete: async () => {
      completeCalls += 1;
      return completion({ text: 'should not run' });
    },
  });

  // One unpairable memory: nothing to relate, slot consumed, rows
  // stamped so the conversation doesn't re-surface until a new recall.
  assertEquals(summary.outcome, 'empty-queue');
  assertEquals(completeCalls, 0);
  assertEquals(updatedTables.includes('memory_conversation'), true);
});

Deno.test('rem sweep: a held guard blocks the run without releasing the other holder', async () => {
  const { admin, rpcCalls } = makeAdmin({
    rpc: remRpcScript({ claim_memory_librarian_inflight: { data: false, error: null } }),
    tables: { memory_conversation: REM_BATCH, app_config: APP_CONFIG },
  });

  const summary = await runRemSweepTick(admin);
  assertEquals(summary.outcome, 'inflight-blocked');
  // Releasing here would steal the other run's guard.
  assertEquals(
    rpcCalls.some((c) => c.name === 'release_memory_librarian_inflight'),
    false,
  );
});

Deno.test('rem manual: collision surfaces as busy; no cadence claim is ever made', async () => {
  const { admin, rpcCalls } = makeAdmin({
    rpc: remRpcScript({ claim_memory_librarian_inflight: { data: false, error: null } }),
    tables: { memory_conversation: REM_BATCH, app_config: APP_CONFIG },
  });

  const result = await runRemManual(admin, 'user-1');
  assertEquals(result.kind, 'busy');
  // Manual runs never touch the scheduled cadence stamp.
  assertEquals(
    rpcCalls.some((c) => c.name === 'claim_next_user_for_rem'),
    false,
  );
});

Deno.test('rem manual: summaries concatenate across processed conversations', async () => {
  const { admin } = makeAdmin({
    rpc: remRpcScript(),
    tables: { memory_conversation: REM_BATCH, app_config: APP_CONFIG },
  });

  const events: string[] = [];
  const result = await runRemManual(
    admin,
    'user-1',
    (e) => events.push(e.kind),
    {
      // deno-lint-ignore require-await
      complete: async () => completion({ text: 'Linked cat and vet (supports).' }),
    },
  );

  assertEquals(result.kind, 'ok');
  if (result.kind === 'ok') {
    assertEquals(result.finalText, 'Linked cat and vet (supports).');
    assertEquals(result.conversationsProcessed, 1);
  }
  // The strip's bracketing events arrive in order around the run.
  assertEquals(events[0], 'preparing');
  assertEquals(events[events.length - 1], 'done');
});

// ---------------------------------------------------------------------------
// deep-sleep
// ---------------------------------------------------------------------------

const SEED_ROW = {
  data: { id: 's1', label: 'cat', data: 'Mochi', confidence: 1.0 },
  error: null,
};

function deepSleepRpcScript(scored: StubResult, overrides: Record<string, StubResult> = {}) {
  return (name: string): StubResult => {
    if (name in overrides) return overrides[name];
    if (name === 'claim_next_user_for_deep_sleep') return { data: 'user-1', error: null };
    if (name === 'claim_memory_librarian_inflight') return { data: true, error: null };
    if (name === 'search_memories_by_embedding_scored') return scored;
    return { data: null, error: null };
  };
}

const EMBED_OK = () => Promise.resolve([0.1, 0.2, 0.3]);

Deno.test('deep-sleep sweep: a lonely seed is stamped visited without reaching Venice', async () => {
  let completeCalls = 0;
  const { admin, updatedTables } = makeAdmin({
    rpc: deepSleepRpcScript({ data: [], error: null }),
    tables: { memories: SEED_ROW, app_config: APP_CONFIG },
  });

  const summary = await runDeepSleepSweepTick(admin, {
    embed: EMBED_OK,
    // deno-lint-ignore require-await
    complete: async () => {
      completeCalls += 1;
      return completion({ text: 'should not run' });
    },
  });

  assertEquals(summary.outcome, 'too-small');
  assertEquals(completeCalls, 0);
  // The visit stamp moves the sweep to a different neighborhood next time.
  assertEquals(updatedTables.includes('memories'), true);
});

Deno.test('deep-sleep batch assembly: threshold filter, seed exclusion, seed-first ordering', async () => {
  const scored = {
    data: [
      { id: 's1', label: 'cat', data: 'Mochi', confidence: 1.0, similarity: 1.0 }, // the seed itself
      { id: 'n1', label: 'cat name', data: 'Mochi the cat', confidence: 2.0, similarity: 0.93 },
      { id: 'n2', label: 'pets', data: 'has a cat', confidence: 1.0, similarity: 0.84 },
      { id: 'n3', label: 'editor', data: 'vim', confidence: 1.0, similarity: 0.41 }, // below gate
    ],
    error: null,
  };
  const { admin } = makeAdmin({
    rpc: deepSleepRpcScript(scored),
    tables: { memories: SEED_ROW, app_config: APP_CONFIG },
  });

  const batch = await deepSleepTest.buildBatchForSeed(
    admin,
    'user-1',
    { id: 's1', label: 'cat', data: 'Mochi', confidence: 1.0 },
    EMBED_OK,
  );

  assertEquals(batch.map((m) => m.id), ['s1', 'n1', 'n2']);
  assertEquals(batch[0].score, 1.0);
  assertEquals(batch[1].score, 0.93);
});

Deno.test('deep-sleep sweep: happy path reviews the neighborhood and stamps the whole batch', async () => {
  const scored = {
    data: [
      { id: 'n1', label: 'cat name', data: 'Mochi the cat', confidence: 2.0, similarity: 0.93 },
    ],
    error: null,
  };
  const { admin, rpcCalls, updatedTables } = makeAdmin({
    rpc: deepSleepRpcScript(scored),
    tables: { memories: SEED_ROW, app_config: APP_CONFIG },
  });

  const summary = await runDeepSleepSweepTick(admin, {
    embed: EMBED_OK,
    // deno-lint-ignore require-await
    complete: async () => completion({ text: 'Merged the two cat memories.' }),
  });

  assertEquals(summary.outcome, 'reviewed');
  assertEquals(summary.batchSize, 2);
  assertEquals(updatedTables.includes('memories'), true);
  assertEquals(
    rpcCalls.some((c) => c.name === 'release_memory_librarian_inflight'),
    true,
  );
});

Deno.test('deep-sleep sweep: an agent failure leaves the batch unvisited for retry', async () => {
  const scored = {
    data: [
      { id: 'n1', label: 'cat name', data: 'Mochi the cat', confidence: 2.0, similarity: 0.93 },
    ],
    error: null,
  };
  const { admin, updatedTables } = makeAdmin({
    rpc: deepSleepRpcScript(scored),
    tables: { memories: SEED_ROW, app_config: APP_CONFIG },
  });

  const summary = await runDeepSleepSweepTick(admin, {
    embed: EMBED_OK,
    // deno-lint-ignore require-await
    complete: async () => {
      throw new Error('Venice chat/completions 500: gateway error');
    },
  });

  assertEquals(summary.outcome, 'error');
  // No visit stamps: the next cycle retries this same neighborhood.
  assertEquals(updatedTables.includes('memories'), false);
});

Deno.test('deep-sleep sweep: an empty embedding degrades to too-small instead of erroring', async () => {
  const { admin, rpcCalls, updatedTables } = makeAdmin({
    rpc: deepSleepRpcScript({ data: [], error: null }),
    tables: { memories: SEED_ROW, app_config: APP_CONFIG },
  });

  const summary = await runDeepSleepSweepTick(admin, {
    embed: () => Promise.resolve(undefined),
  });

  assertEquals(summary.outcome, 'too-small');
  // Without a vector there is nothing to search against.
  assertEquals(
    rpcCalls.some((c) => c.name === 'search_memories_by_embedding_scored'),
    false,
  );
  assertEquals(updatedTables.includes('memories'), true);
});
