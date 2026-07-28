// Guards for the memory librarians' safety-critical composition and
// prompt shape. The browser asserted these against the shared
// memoryLibrarianToolbox and the per-agent prompt modules; all of it
// moved server-side when the rem + deep-sleep fleets migrated, so the
// invariants live here:
//
//   - The shared toolbox is reads (memory/conversation search) plus
//     content + graph maintenance (consolidate, reshape, invalidate,
//     doubt, relate, unrelate). memory_reshape is the one sanctioned
//     content rewrite - framing only, no fact or confidence change.
//     NO memory_create (the librarian never invents), no memory_update
//     (reflection's refine-a-fact verb, not the librarian's), no
//     memory_reaffirm (global-view agents would over-corroborate), no
//     memory_delete, no ask_user.
//   - Each agent's prompt names its own attractor (co-occurrence for
//     rem, similarity for deep-sleep) and frames "no changes" as the
//     default outcome.
//   - The batch renderers carry the confidence tags and, for
//     deep-sleep, the SEED marker + similarity scores the agent
//     self-tiers on.

import { assertEquals, assertStringIncludes } from '@std/assert';
import { buildMemoryLibrarianToolbox } from '../venice/agents/_memory_librarian_tools.ts';
import { buildRemPrompt, __test as remTest } from '../venice/agents/rem.ts';
import {
  buildDeepSleepPrompt,
  __test as deepSleepTest,
} from '../venice/agents/deep_sleep.ts';

Deno.test('librarian toolbox is reads + graph maintenance, in declared order', () => {
  const toolbox = buildMemoryLibrarianToolbox();
  assertEquals(toolbox.name, 'memory-librarian');
  assertEquals(
    toolbox.tools.map((t) => t.name),
    [
      'memory_search',
      'memory_consolidate',
      'memory_reshape',
      'memory_invalidate',
      'memory_doubt',
      'memory_relate',
      'memory_unrelate',
      'conversation_search',
    ],
  );
});

Deno.test('librarian toolbox excludes generation, bumps, hard deletes, and the UI tool', () => {
  const names = buildMemoryLibrarianToolbox().tools.map((t) => t.name);
  for (const forbidden of [
    'memory_create',
    'memory_update',
    'memory_reaffirm',
    'memory_delete',
    'memory_recall',
    'ask_user',
  ]) {
    assertEquals(names.includes(forbidden), false, `${forbidden} must not be reachable`);
  }
});

Deno.test('every librarian tool carries a wire schema whose name matches', () => {
  for (const tool of buildMemoryLibrarianToolbox().tools) {
    assertEquals(tool.wire.type, 'function');
    assertEquals(tool.wire.function.name, tool.name);
  }
});

Deno.test('rem prompt names the co-occurrence attractor and relate-first discipline', () => {
  const prompt = buildRemPrompt({
    batchList: '- (conf=1.00, id=m1) `cat name` - Mochi',
    batchSize: 1,
  });
  assertStringIncludes(prompt, 'rem (associative');
  assertStringIncludes(prompt, "Rem's job is graph hygiene, not consolidation.");
  assertStringIncludes(prompt, 'No tool calls is a valid outcome.');
  assertStringIncludes(prompt, '- (conf=1.00, id=m1) `cat name` - Mochi');
  // The librarian discipline both prompts share.
  assertStringIncludes(prompt, 'librarian collapses, reflection\ngenerates');
});

Deno.test('deep-sleep prompt names the similarity attractor and score tiers', () => {
  const prompt = buildDeepSleepPrompt({
    batchList: '- [SEED] (conf=1.00, id=m1) `cat name` - Mochi',
    batchSize: 1,
  });
  assertStringIncludes(prompt, 'deep-sleep pass');
  assertStringIncludes(prompt, 'The librarian collapses; reflection generates.');
  assertStringIncludes(prompt, 'Score is a signal, not a verdict.');
  assertStringIncludes(prompt, '- [SEED] (conf=1.00, id=m1) `cat name` - Mochi');
});

Deno.test('both librarian prompts grant memory_reshape for de-poisoning, facts preserved', () => {
  const rem = buildRemPrompt({ batchList: '- (conf=1.00, id=m1) `x` - y', batchSize: 1 });
  const deep = buildDeepSleepPrompt({
    batchList: '- [SEED] (conf=1.00, id=m1) `x` - y',
    batchSize: 1,
  });
  for (const prompt of [rem, deep]) {
    assertStringIncludes(prompt, 'memory_reshape');
    // Scoped to encoding-time framing, not fact edits.
    assertStringIncludes(prompt, 'this conversation');
    assertStringIncludes(prompt, 'preserve every number, name, decision');
  }
});

Deno.test('rem batch renderer squashes whitespace and tags confidence bands', () => {
  const list = remTest.renderBatchList([
    { id: 'm1', label: 'cat\n name', data: 'Mochi  the\tcat', confidence: 1.0 },
    { id: 'm2', label: 'editor', data: 'vim', confidence: 7.0 },
    { id: 'm3', label: 'os', data: 'arch', confidence: 2.0 },
  ]);
  const rows = list.split('\n');
  // 1.0 sits in the hedged band; 7.0 is corroborated; 2.0 is the
  // deliberately-untagged neutral band.
  assertEquals(rows[0], '- (hedged conf=1.00, id=m1) `cat name` - Mochi the cat');
  assertEquals(rows[1], '- (corroborated conf=7.00, id=m2) `editor` - vim');
  assertEquals(rows[2], '- (conf=2.00, id=m3) `os` - arch');
  assertEquals(remTest.renderBatchList([]), '(empty batch)');
});

Deno.test('deep-sleep batch renderer marks the seed and renders neighbor scores', () => {
  const list = deepSleepTest.renderBatchList([
    { id: 's', label: 'seed', data: 'fact', confidence: 2.0, score: 1.0 },
    { id: 'n1', label: 'near', data: 'same fact', confidence: 2.0, score: 0.927 },
  ]);
  const rows = list.split('\n');
  assertEquals(rows[0], '- [SEED] (conf=2.00, id=s) `seed` - fact');
  assertEquals(rows[1], '- [0.93] (conf=2.00, id=n1) `near` - same fact');
});

// The librarian's memory_search is the shared tool plus a per-row
// `hygiene` note on oversized bodies. It is wrapped here rather than
// annotated in memory_search itself because that tool is shared with the
// main chat and reflection, neither of which carries memory_reshape -
// a "this wants condensing" note in front of a caller that cannot act on
// it is noise on a hot path.
function scriptedAdminClient(rows: Array<Record<string, unknown>>): unknown {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'or']) chain[m] = () => chain;
  chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
    resolve({ data: rows, error: null });
  return {
    from: () => chain,
    // Relation hydration; empty is fine, the search result stands alone.
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

async function searchWithHygiene(
  bodies: string[],
): Promise<Array<Record<string, unknown>>> {
  const tool = buildMemoryLibrarianToolbox().tools.find(
    (t) => t.name === 'memory_search',
  );
  if (!tool) throw new Error('memory_search missing from the librarian toolbox');
  const rows = bodies.map((data, i) => ({
    id: `m${i}`,
    label: `row ${i}`,
    data,
    confidence: 2.0,
    updated_at: '2026-07-01T00:00:00Z',
  }));
  // Empty query takes the list-all path, which needs no Venice key.
  const out = await tool.execute(
    { query: '' },
    {
      adminClient: scriptedAdminClient(rows) as never,
      userId: 'u-1',
      threadId: null,
      signal: new AbortController().signal,
      depth: 0,
    },
  );
  return out as Array<Record<string, unknown>>;
}

Deno.test('librarian memory_search annotates only the oversized rows', async () => {
  const [healthy, trim, condense] = await searchWithHygiene([
    'x'.repeat(500),
    'x'.repeat(3200),
    'x'.repeat(7000),
  ]);
  // A short row carries no note - absence is how "leave this alone"
  // reaches the model.
  assertEquals('hygiene' in healthy, false);
  assertStringIncludes(String(trim.hygiene), '3200');
  assertStringIncludes(String(condense.hygiene), '7000');
  // The wrapper is additive: the underlying row survives untouched.
  assertEquals(healthy.id, 'm0');
  assertEquals(trim.data, 'x'.repeat(3200));
});
