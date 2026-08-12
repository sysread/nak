// Parity + composition guards for the curation work units
// (supabase/functions/venice/agents/{auto_title,summary,thread_topics,
// memory_topics,recipe_topics,curation}.ts). The units are ports of
// the browser worker fleet and their prompts/validators are a QA
// contract - these tests assert the validator behavior matches the
// browser suites (tests/title-gen.test.ts, tests/topics-agent.test.ts
// and siblings) on the cases that have bitten before, and pin the
// composition invariants ./curation.ts documents.
//
// Pure: every assertion drives an exported __test surface; no DB,
// no network, no Supabase env.

import { assert, assertEquals } from '@std/assert';
import { __test as autoTitle } from '../venice/agents/auto_title.ts';
import { __test as summary } from '../venice/agents/summary.ts';
import { __test as threadTopics } from '../venice/agents/thread_topics.ts';
import { __test as memoryTopics } from '../venice/agents/memory_topics.ts';
import { __test as recipeTopics } from '../venice/agents/recipe_topics.ts';
import { __test as curation } from '../venice/agents/curation.ts';
import {
  CURATION_INPUT_TOKEN_BUDGET,
  repairToolCallFanIn,
  __test as curationHelpers,
} from '../venice/agents/_curation_helpers.ts';
import type { StoredMessage } from '../venice/agents/_recall_helpers.ts';

// --- auto_title: sanitizeTitle ------------------------------------------

Deno.test('sanitizeTitle takes only the first non-empty line when the model embeds its response', () => {
  const raw =
    'Holy Spirit Origins in Christianity\n\nThe concept of the "Holy Spirit" (Greek: *P';
  assertEquals(autoTitle.sanitizeTitle(raw), 'Holy Spirit Origins in Christianity');
});

Deno.test('sanitizeTitle trims, strips wrapping quotes and trailing punctuation', () => {
  assertEquals(autoTitle.sanitizeTitle('  "Casual Howdy Greeting."  '), 'Casual Howdy Greeting');
});

Deno.test('sanitizeTitle strips wrapping Markdown emphasis the model adds', () => {
  // The chat surface primes the model toward **bold**/*italics* in prose and
  // the small auto-title model wraps titles the same way; the strip is what
  // keeps the markup out of the drawer.
  assertEquals(autoTitle.sanitizeTitle('**Crested Butte Weekend Trip**'), 'Crested Butte Weekend Trip');
  assertEquals(autoTitle.sanitizeTitle('*Refrigerator Repair*'), 'Refrigerator Repair');
  assertEquals(autoTitle.sanitizeTitle('`git rebase workflow`'), 'Git rebase workflow');
  assertEquals(autoTitle.sanitizeTitle('## Sourdough Starter Tips'), 'Sourdough Starter Tips');
  // Combined wrapping: bold around a quoted, period-terminated title.
  assertEquals(autoTitle.sanitizeTitle('**"Holy Spirit Origins."**'), 'Holy Spirit Origins');
});

Deno.test('sanitizeTitle preserves Markdown-like characters mid-title', () => {
  // Only anchored wrapping markers are stripped; interior characters that
  // happen to be Markdown punctuation are part of the real title.
  assertEquals(autoTitle.sanitizeTitle('A* search vs Dijkstra'), 'A* search vs Dijkstra');
  assertEquals(autoTitle.sanitizeTitle('C# vs F# performance'), 'C# vs F# performance');
});

Deno.test('sanitizeTitle caps a long single line at 80 chars', () => {
  const raw =
    'Hafa adai is a Chamorro greeting from Guam meaning hello and it is not a band, common';
  const out = autoTitle.sanitizeTitle(raw);
  assert(out.length <= 80);
  assertEquals(out, raw.slice(0, 80));
});

Deno.test('sanitizeTitle uppercases only the first character', () => {
  assertEquals(
    autoTitle.sanitizeTitle('troubleshooting the refrigerator'),
    'Troubleshooting the refrigerator',
  );
  assertEquals(autoTitle.sanitizeTitle('iOS upgrade walkthrough'), 'IOS upgrade walkthrough');
});

Deno.test('sanitizeTitle returns empty string on whitespace-only input', () => {
  assertEquals(autoTitle.sanitizeTitle('\n\n   \r\n  '), '');
});

// --- summary: trimSummary -------------------------------------------------

Deno.test('trimSummary strips wrapping quotes and caps at 600 chars', () => {
  assertEquals(summary.trimSummary('  "A summary."  '), 'A summary.');
  assertEquals(summary.trimSummary('x'.repeat(700)).length, 600);
});

// --- condenseForCuration: message cap + token budget ----------------------

function storedMsg(role: StoredMessage['role'], i: number, toolCalls = false): StoredMessage {
  return {
    id: `m${i}`,
    role,
    content: `c${i}`,
    tool_calls: toolCalls
      ? [{ id: 'abcdefghi', type: 'function', function: { name: 'f', arguments: '{}' } }]
      : null,
    tool_call_id: role === 'tool' ? 'abcdefghi' : null,
    name: null,
  };
}

Deno.test('condenseForCuration passes short threads through untouched', () => {
  const all = Array.from({ length: 10 }, (_, i) => storedMsg('user', i));
  assertEquals(curationHelpers.condenseForCuration(all), all);
});

Deno.test('condenseForCuration trims the head/tail seam to safe wire boundaries', () => {
  // 200 rows so the 40/-80 split engages. Put a tool row at index 39
  // (end of head) and an assistant row at index 120 (start of tail):
  // without the seam trims the wire would serialise tool -> assistant
  // mid-turn, which providers reject.
  const all = Array.from({ length: 200 }, (_, i) => {
    if (i === 38) return storedMsg('assistant', i, true);
    if (i === 39) return storedMsg('tool', i);
    if (i === 120) return storedMsg('assistant', i);
    return storedMsg(i % 2 === 0 ? 'user' : 'assistant', i);
  });
  const out = curationHelpers.condenseForCuration(all);
  assert(out.length < all.length);
  // Head must not end on a tool row or an assistant with unanswered
  // tool_calls; tail must start at a user (or system) row.
  const headEnd = out[37];
  assertEquals(headEnd.role === 'tool', false);
  const tailStartIdx = out.findIndex((m) => Number(m.id.slice(1)) >= 120);
  assertEquals(out[tailStartIdx].role, 'user');
});

// Rough mirror of estimateWireTokens' 4-chars-per-token assumption, so
// the assertions below can talk in tokens without importing the
// accumulator's private constant.
function estimatedTokens(messages: StoredMessage[]): number {
  return messages.reduce(
    (sum, m) =>
      sum +
      Math.ceil(
        (m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)) / 4,
      ),
    0,
  );
}

Deno.test('condenseForCuration excerpts oversized rows, tool results hardest', () => {
  const bigTool: StoredMessage = { ...storedMsg('tool', 1), content: 'x'.repeat(50_000) };
  const bigUser: StoredMessage = { ...storedMsg('user', 2), content: 'y'.repeat(50_000) };
  const [outTool, outUser] = curationHelpers.condenseForCuration([bigTool, bigUser]);
  // Tool results carry the tighter cap (2k vs 8k) - one search dump
  // must not displace a dozen user turns.
  assert(outTool.content.length < outUser.content.length);
  assert(outTool.content.length < 2_500);
  assert(outUser.content.length < 8_500);
});

Deno.test('condenseForCuration drops from the middle until the token budget fits', () => {
  // 100 rows x ~8k chars each is ~200k estimated tokens under the
  // message cap - exactly the shape that 400d thread-topics with
  // "maximum context length is 128000 tokens".
  const all = Array.from({ length: 100 }, (_, i) => ({
    ...storedMsg(i % 2 === 0 ? 'user' : 'assistant', i),
    content: `${i}`.padEnd(8_000, 'z'),
  }));
  assert(estimatedTokens(all) > CURATION_INPUT_TOKEN_BUDGET);

  const out = curationHelpers.condenseForCuration(all);
  assert(estimatedTokens(out) <= CURATION_INPUT_TOKEN_BUDGET);
  // Both ends survive: origin tells the model what the thread was
  // launched into, outcome is what it mostly gets tagged on.
  assertEquals(out[0].id, 'm0');
  assertEquals(out[out.length - 1].id, 'm99');
});

Deno.test('condenseForCuration keeps the newest row when it alone busts the budget', () => {
  // A pathological final turn must still produce a transcript - an
  // empty one would fail the cycle forever instead of tagging off what
  // the thread most recently said.
  const out = curationHelpers.condenseForCuration(
    [{ ...storedMsg('user', 0), content: 'q'.repeat(400_000) }],
    100,
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].id, 'm0');
});

// --- repairToolCallFanIn: wire-shape repair before the Venice call --------

function asstCall(id: string, callIds: string[]): StoredMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    tool_calls: callIds.map((cid) => ({
      id: cid,
      type: 'function',
      function: { name: 'context', arguments: '{}' },
    })),
    tool_call_id: null,
    name: null,
  };
}

function toolRes(id: string, callId: string): StoredMessage {
  return {
    id,
    role: 'tool',
    content: 'result',
    tool_calls: null,
    tool_call_id: callId,
    name: 'context',
  };
}

function plain(role: StoredMessage['role'], id: string): StoredMessage {
  return { id, role, content: id, tool_calls: null, tool_call_id: null, name: null };
}

// Assert the slice satisfies the three wire rules Venice enforces: every
// tool-result row sits in the block right after the assistant that
// called its id, every assistant-with-tool_calls block is followed by an
// assistant, and no tool row is an orphan.
function assertWireValid(msgs: StoredMessage[]): void {
  let k = 0;
  while (k < msgs.length) {
    const m = msgs[k];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids = new Set((m.tool_calls as Array<{ id: string }>).map((c) => c.id));
      const seen = new Set<string>();
      let p = k + 1;
      while (p < msgs.length && msgs[p].role === 'tool') {
        const tcid = msgs[p].tool_call_id!;
        assert(ids.has(tcid), `tool ${tcid} not a call of its block`);
        assert(!seen.has(tcid), `duplicate tool result ${tcid}`);
        seen.add(tcid);
        p++;
      }
      assertEquals(seen.size, ids.size, 'every call answered exactly once');
      const next = p < msgs.length ? msgs[p] : null;
      assert(next === null ? false : next.role === 'assistant', 'block followed by assistant');
      k = p;
      continue;
    }
    assert(m.role !== 'tool', `orphan tool row ${m.tool_call_id}`);
    k++;
  }
}

Deno.test('repairToolCallFanIn is a reference no-op on an already-valid thread', () => {
  const msgs = [
    plain('user', 'u0'),
    asstCall('a1', ['call_aaa']),
    toolRes('t1', 'call_aaa'),
    plain('assistant', 'a2'),
  ];
  assert(repairToolCallFanIn(msgs) === msgs);
});

Deno.test('repairToolCallFanIn synthesizes a stub result for an unanswered call', () => {
  const msgs = [
    plain('user', 'u0'),
    asstCall('a1', ['call_aaa']),
    plain('assistant', 'a2'),
  ];
  const out = repairToolCallFanIn(msgs);
  assertWireValid(out);
  // a1's call gets a synthesized tool row before the next assistant.
  assertEquals(out[2].role, 'tool');
  assertEquals(out[2].tool_call_id, 'call_aaa');
});

Deno.test('repairToolCallFanIn drops orphan/misplaced tool results and synthesizes the gaps', () => {
  // The thread a0e7940e shape: two tool-calling assistants whose results
  // landed late (after the text replies), so they sort as orphan tool
  // rows. Each call gets a synthesized in-position result; the stranded
  // late rows are dropped rather than emitted as unexpected ids.
  const msgs = [
    plain('user', 'u0'),
    asstCall('a1', ['call_aaa']),
    asstCall('a2', ['call_bbb']),
    asstCall('a3', ['call_ccc']),
    toolRes('t3', 'call_ccc'),
    plain('assistant', 'text1'),
    plain('assistant', 'text2'),
    toolRes('late1', 'call_aaa'),
    toolRes('late2', 'call_bbb'),
    plain('user', 'u1'),
  ];
  const out = repairToolCallFanIn(msgs);
  assertWireValid(out);
  // The late orphan rows are gone.
  assert(!out.some((m) => m.id === 'late1' || m.id === 'late2'));
  // No user immediately follows a tool block (the orphan run is dropped,
  // not closed with a recovery assistant).
  for (let n = 1; n < out.length; n++) {
    if (out[n].role === 'user') assert(out[n - 1].role !== 'tool');
  }
});

Deno.test('repairToolCallFanIn drops a mismatched tool row inside an otherwise-valid block', () => {
  const msgs = [
    asstCall('a1', ['call_aaa']),
    toolRes('t1', 'call_aaa'),
    toolRes('stray', 'call_zzz'),
    plain('assistant', 'a2'),
  ];
  const out = repairToolCallFanIn(msgs);
  assertWireValid(out);
  assert(!out.some((m) => m.id === 'stray'));
});

Deno.test('repairToolCallFanIn closes a complete tool block that runs into a user turn', () => {
  const msgs = [
    asstCall('a1', ['call_aaa']),
    toolRes('t1', 'call_aaa'),
    plain('user', 'u1'),
  ];
  const out = repairToolCallFanIn(msgs);
  assertWireValid(out);
  // A recovery assistant sits between the tool block and the user turn.
  assertEquals(out[2].role, 'assistant');
});

Deno.test('repairToolCallFanIn is a reference no-op on an empty slice', () => {
  const empty: StoredMessage[] = [];
  assert(repairToolCallFanIn(empty) === empty);
});

Deno.test('repairToolCallFanIn closes a trailing tool-calling assistant at end of slice', () => {
  // Interrupted final round: assistant called a tool, nothing landed,
  // conversation ends. Synthesize the result AND a recovery assistant so
  // the block doesn't end the slice on a tool row.
  const msgs = [plain('user', 'u0'), asstCall('a1', ['call_aaa'])];
  const out = repairToolCallFanIn(msgs);
  assertWireValid(out);
  assertEquals(out.length, 4);
  assertEquals(out[2].role, 'tool');
  assertEquals(out[2].tool_call_id, 'call_aaa');
  assertEquals(out[3].role, 'assistant');
});

Deno.test('repairToolCallFanIn fills only the unanswered calls in a partial fan-in', () => {
  // Assistant called two tools; only the first result landed.
  const msgs = [
    asstCall('a1', ['call_aaa', 'call_bbb']),
    toolRes('t1', 'call_aaa'),
    plain('assistant', 'a2'),
  ];
  const out = repairToolCallFanIn(msgs);
  assertWireValid(out);
  // Real result for call_aaa kept; call_bbb synthesized.
  assertEquals(out[1].id, 't1');
  assertEquals(out[2].tool_call_id, 'call_bbb');
  assertEquals(out[2].content, '(tool execution was interrupted - no result available)');
});

Deno.test('repairToolCallFanIn de-dupes a repeated tool result for the same call', () => {
  const msgs = [
    asstCall('a1', ['call_aaa']),
    toolRes('t1', 'call_aaa'),
    toolRes('t1-dup', 'call_aaa'),
    plain('assistant', 'a2'),
  ];
  const out = repairToolCallFanIn(msgs);
  assertWireValid(out);
  // First result kept, duplicate dropped.
  assert(out.some((m) => m.id === 't1'));
  assert(!out.some((m) => m.id === 't1-dup'));
});

Deno.test('repairToolCallFanIn output is idempotent - a second pass is a reference no-op', () => {
  const msgs = [
    plain('user', 'u0'),
    asstCall('a1', ['call_aaa']),
    asstCall('a2', ['call_bbb']),
    asstCall('a3', ['call_ccc']),
    toolRes('t3', 'call_ccc'),
    plain('assistant', 'text1'),
    toolRes('late1', 'call_aaa'),
    plain('user', 'u1'),
  ];
  const once = repairToolCallFanIn(msgs);
  assertWireValid(once);
  // Re-running on already-valid output must change nothing and return the
  // same array by reference - the curation path can re-enter without
  // stacking phantom rows.
  assert(repairToolCallFanIn(once) === once);
});

// --- topics validators: parity across the three units --------------------

Deno.test('thread parseTopics parses, normalises, dedupes, and caps at 4', () => {
  assertEquals(
    threadTopics.parseTopics('{"topics": ["Baking", "baking!", "bread", "a","b","c"]}'),
    ['baking', 'bread', 'a', 'b'],
  );
});

Deno.test('thread parseTopics strips a ```json fence', () => {
  assertEquals(threadTopics.parseTopics('```json\n{"topics":["baking"]}\n```'), ['baking']);
});

Deno.test('thread parseTopics returns [] on garbage', () => {
  assertEquals(threadTopics.parseTopics('not json'), []);
  assertEquals(threadTopics.parseTopics('{"nope": []}'), []);
});

Deno.test('normaliseTag rejects the (untagged) sentinel in all three units', () => {
  // "(untagged)" strips to "untagged" (parens are non-alphanum), which
  // is allowed - the guard targets the literal sentinel value.
  for (const unit of [threadTopics, memoryTopics, recipeTopics]) {
    assertEquals(unit.normaliseTag('(untagged)'), 'untagged');
    assertEquals(unit.normaliseTag('cooking 101'), 'cooking-101');
    assertEquals(unit.normaliseTag('a'.repeat(41)), null);
    assertEquals(unit.normaliseTag(42), null);
  }
});

Deno.test('memory parseTopics caps at 4; recipe parseTopics caps at 6', () => {
  const eight = '{"topics": ["a","b","c","d","e","f","g","h"]}';
  assertEquals(memoryTopics.parseTopics(eight), ['a', 'b', 'c', 'd']);
  assertEquals(recipeTopics.parseTopics(eight), ['a', 'b', 'c', 'd', 'e', 'f']);
  assertEquals(recipeTopics.MAX_RECIPE_TOPICS, 6);
});

// --- curation composition -------------------------------------------------

Deno.test('curation walks auto-title first - title latency is load-bearing UX', () => {
  assertEquals(
    curation.UNITS.map((u) => u.source),
    ['auto-title', 'topics', 'summary', 'memory-topics', 'recipe-topics', 'rechunk'],
  );
});

Deno.test('only the model-free unit gets the raised sweep cap', () => {
  // The two caps bound different resources - Venice spend vs. database
  // time - so a unit that starts calling a model must drop back to the
  // default rather than inheriting the model-free one.
  for (const unit of curation.UNITS) {
    if (unit.source === 'rechunk') {
      assertEquals(unit.sweepCap, curation.SWEEP_QUEUE_CAP_MODEL_FREE);
    } else {
      assertEquals(unit.sweepCap, undefined);
    }
  }
  assert(curation.SWEEP_QUEUE_CAP_MODEL_FREE > curation.SWEEP_QUEUE_CAP);
});

Deno.test('every unit tallies into a distinct counter on its own saved outcome', () => {
  // A unit sharing another's tallyKey would silently double-count the
  // sweep's per-queue numbers, which are the only visibility into
  // whether a queue is draining.
  const keys = curation.UNITS.map((u) => u.tallyKey);
  assertEquals(new Set(keys).size, keys.length);
  for (const unit of curation.UNITS) {
    assert(unit.drainOn.has(unit.savedOutcome));
  }
});

Deno.test('curation drain sets mirror the browser supervisor progress classification', () => {
  const bySource = new Map(curation.UNITS.map((u) => [u.source, u]));
  // auto-title: no-title counted as progress (immediate retry).
  assertEquals([...bySource.get('auto-title')!.drainOn].sort(), ['claim-lost', 'no-title', 'titled']);
  // summary: empty-summary stops the drain (claim left to TTL).
  assertEquals([...bySource.get('summary')!.drainOn].sort(), ['claim-lost', 'summarised']);
  // topics family: empty-topics stops the drain (nap, retry later).
  for (const source of ['topics', 'memory-topics', 'recipe-topics']) {
    assertEquals([...bySource.get(source)!.drainOn].sort(), ['claim-lost', 'tagged']);
  }
  // 'error' belongs to none of them - drainUnit owns that outcome, and
  // a unit that classified it either way would defeat the step-over.
  for (const unit of curation.UNITS) {
    assert(!unit.drainOn.has(curation.ERROR_OUTCOME));
  }
});

// A drain harness over a scripted outcome list: `runOnce` walks the
// script, and the returned log records what drainUnit actually
// consumed so a test can assert how far the pass got.
function drainOver(outcomes: readonly string[], cap: number) {
  const unit = { drainOn: new Set(['saved', 'claim-lost']) } as never;
  const seen: string[] = [];
  const throws: unknown[] = [];
  let i = 0;
  return {
    seen,
    throws,
    run: () =>
      curation.drainUnit(
        unit,
        cap,
        () => {
          const next = outcomes[i++];
          if (next === 'THROW') throw new Error('contract violation');
          return Promise.resolve(next ?? 'empty-queue');
        },
        (o: string) => seen.push(o),
        (e: unknown) => throws.push(e),
      ),
  };
}

Deno.test('drain steps over an isolated failing row instead of stalling', async () => {
  // The regression this guards: a poisoned row at the head of the
  // queue (claim order is updated_at asc) used to break the pass on
  // its first iteration, so the rows behind it were never claimed.
  const h = drainOver(['error', 'saved', 'saved'], 5);
  await h.run();
  assertEquals(h.seen, ['error', 'saved', 'saved', 'empty-queue']);
});

Deno.test('drain bails once errors run consecutively - a failing backend, not a bad row', async () => {
  const h = drainOver(Array(10).fill('error'), 10);
  await h.run();
  assertEquals(h.seen.length, curation.MAX_CONSECUTIVE_ERRORS);
});

Deno.test('drain resets its error run on any progress outcome', async () => {
  // Alternating error/saved must never accumulate to the bail
  // threshold - each save proves the backend is alive.
  const h = drainOver(['error', 'saved', 'error', 'saved', 'error', 'saved'], 6);
  await h.run();
  assertEquals(h.seen.length, 6);
});

Deno.test('drain still stops on a non-progress outcome and on a thrown unit', async () => {
  const stopped = drainOver(['empty-queue', 'saved'], 5);
  await stopped.run();
  assertEquals(stopped.seen, ['empty-queue']);

  const threw = drainOver(['THROW', 'saved'], 5);
  await threw.run();
  assertEquals(threw.seen, []);
  assertEquals(threw.throws.length, 1);
});

Deno.test('drain reports cap exhaustion only when the queue is still producing', async () => {
  const capped = drainOver(['saved', 'saved'], 2);
  assertEquals(await capped.run(), true);

  const dry = drainOver(['saved', 'empty-queue'], 5);
  assertEquals(await dry.run(), false);
});
