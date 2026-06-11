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

// --- summary: trimSummary + condenseHistory ------------------------------

Deno.test('trimSummary strips wrapping quotes and caps at 600 chars', () => {
  assertEquals(summary.trimSummary('  "A summary."  '), 'A summary.');
  assertEquals(summary.trimSummary('x'.repeat(700)).length, 600);
});

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

Deno.test('condenseHistory passes short threads through untouched', () => {
  const all = Array.from({ length: 10 }, (_, i) => storedMsg('user', i));
  assertEquals(summary.condenseHistory(all), all);
});

Deno.test('condenseHistory trims the head/tail seam to safe wire boundaries', () => {
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
  const out = summary.condenseHistory(all);
  assert(out.length < all.length);
  // Head must not end on a tool row or an assistant with unanswered
  // tool_calls; tail must start at a user (or system) row.
  const headEnd = out[37];
  assertEquals(headEnd.role === 'tool', false);
  const tailStartIdx = out.findIndex((m) => Number(m.id.slice(1)) >= 120);
  assertEquals(out[tailStartIdx].role, 'user');
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
    ['auto-title', 'topics', 'summary', 'memory-topics', 'recipe-topics'],
  );
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
});
