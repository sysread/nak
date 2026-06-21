// Guards for the manual wiki agent's JSON parser, record-op validation,
// and prompt invariants.
//
// The browser used to assert the parser against
// src/lib/agents/wiki/agent.ts's __test; that agent moved server-side
// (the last agent LLM call that hadn't), so the safety logic lives here
// now:
//
//   - hallucinated-id rejection: an update/delete naming a record id the
//     model was never shown is dropped before it can reach the preview
//     and thus a DB write;
//   - the body-vs-records noop detection that feeds off it;
//   - the per-op normalisation (tag coercion, drop-empty-update);
//   - the manual prompt's "About the user" anti-name-fabrication block
//     (shared with the autonomous agent) and the load-bearing "do not
//     discard facts" rule.
//
// Pure: every function under test parses strings / builds strings, no DB
// or network. The preview-DISPLAY primitives (describeRecordOps,
// recordOpsHeadline) stay browser-side and keep their vitest coverage in
// tests/wiki-manual.test.ts.

import { assertEquals, assertStringIncludes } from '@std/assert';
import { __test } from '../venice/agents/wiki_manual.ts';

const { parseManualDecision, parseRecordOps, renderRecordsForPrompt, buildWikiManualPrompt } =
  __test;

Deno.test('parseRecordOps accepts a well-formed create and coerces its tags', () => {
  const ops = parseRecordOps(
    [{ op: 'create', date: '2026-06-21', content: 'A bake', tags: ['a', 'a', '', 'b'] }],
    new Set(['rec-1', 'rec-2']),
  );
  assertEquals(ops, [{ op: 'create', date: '2026-06-21', content: 'A bake', tags: ['a', 'b'] }]);
});

Deno.test('parseRecordOps drops a create missing date or content', () => {
  const known = new Set(['rec-1']);
  assertEquals(parseRecordOps([{ op: 'create', content: 'no date' }], known), []);
  assertEquals(parseRecordOps([{ op: 'create', date: '2026-06-21', content: '   ' }], known), []);
});

Deno.test('parseRecordOps keeps an update only for a known id with a changed field', () => {
  const ops = parseRecordOps(
    [{ op: 'update', id: 'rec-1', content: 'fixed text' }],
    new Set(['rec-1']),
  );
  assertEquals(ops, [{ op: 'update', id: 'rec-1', content: 'fixed text' }]);
});

Deno.test('parseRecordOps drops an update referencing an id the model was never shown', () => {
  // Hallucinated-id rejection: the whole reason knownIds is threaded
  // through the parser. A phantom id must never reach the preview.
  assertEquals(parseRecordOps([{ op: 'update', id: 'ghost', content: 'x' }], new Set(['rec-1'])), []);
});

Deno.test('parseRecordOps drops an update that changes nothing', () => {
  assertEquals(parseRecordOps([{ op: 'update', id: 'rec-1' }], new Set(['rec-1'])), []);
});

Deno.test('parseRecordOps keeps a delete for a known id, drops one for an unknown id', () => {
  const known = new Set(['rec-1', 'rec-2']);
  assertEquals(parseRecordOps([{ op: 'delete', id: 'rec-2' }], known), [
    { op: 'delete', id: 'rec-2' },
  ]);
  assertEquals(parseRecordOps([{ op: 'delete', id: 'ghost' }], known), []);
});

Deno.test('parseRecordOps skips garbage entries and a non-array payload', () => {
  const known = new Set(['rec-1']);
  assertEquals(parseRecordOps('nope', known), []);
  assertEquals(parseRecordOps([null, 42, { op: 'frobnicate' }, {}], known), []);
});

Deno.test('parseManualDecision parses a body update plus record ops', () => {
  const text = JSON.stringify({
    action: 'update',
    title: 'New title',
    content: 'New body',
    reason: 'Did the thing',
    records: [{ op: 'delete', id: 'rec-1' }],
  });
  assertEquals(parseManualDecision(text, new Set(['rec-1'])), {
    action: 'update',
    title: 'New title',
    content: 'New body',
    reason: 'Did the thing',
    records: [{ op: 'delete', id: 'rec-1' }],
  });
});

Deno.test('parseManualDecision parses a records-only noop (action noop, records present)', () => {
  const text = JSON.stringify({
    action: 'noop',
    reason: 'Just logging a bake',
    records: [{ op: 'create', date: '2026-06-21', content: 'A bake' }],
  });
  const decision = parseManualDecision(text, new Set(['rec-1']));
  assertEquals(decision?.action, 'noop');
  assertEquals(decision?.records, [
    { op: 'create', date: '2026-06-21', content: 'A bake', tags: [] },
  ]);
});

Deno.test('parseManualDecision tolerates a markdown code fence around the JSON', () => {
  const text = '```json\n{"action":"noop","reason":"fine","records":[]}\n```';
  const decision = parseManualDecision(text, new Set(['rec-1']));
  assertEquals(decision?.action, 'noop');
  assertEquals(decision?.records, []);
});

Deno.test('parseManualDecision returns null on unparseable text', () => {
  assertEquals(parseManualDecision('not json at all', new Set()), null);
  assertEquals(parseManualDecision('', new Set()), null);
});

Deno.test('parseManualDecision defaults a missing records field to an empty array', () => {
  const decision = parseManualDecision('{"action":"update","content":"x"}', new Set(['rec-1']));
  assertEquals(decision?.records, []);
});

Deno.test('renderRecordsForPrompt names the empty case', () => {
  assertEquals(renderRecordsForPrompt([]), 'This article has no records yet.');
});

Deno.test('renderRecordsForPrompt lists each record with id, date, tags, and body', () => {
  const text = renderRecordsForPrompt([
    { id: 'rec-1', date: '2026-06-17', content: 'Baked an 80% hydration loaf', tags: ['sourdough'] },
  ]);
  assertStringIncludes(text, '[id: rec-1]');
  assertStringIncludes(text, '2026-06-17');
  assertStringIncludes(text, '(tags: sourdough)');
  assertStringIncludes(text, 'Baked an 80% hydration loaf');
});

Deno.test('renderRecordsForPrompt notes overflow when more records exist than it lists', () => {
  const many = Array.from({ length: 105 }, (_, i) => ({
    id: `rec-${i}`,
    date: '2026-06-17',
    content: 'x',
    tags: [],
  }));
  assertStringIncludes(renderRecordsForPrompt(many), 'not shown');
});

Deno.test('buildWikiManualPrompt always carries the do-not-discard-facts rule', () => {
  const prompt = buildWikiManualPrompt({ userProfile: null });
  assertStringIncludes(prompt, 'Do NOT discard existing facts');
  // No profile -> no "About the user" block, no name preference lines.
  assertEquals(prompt.includes('About the user'), false);
});

Deno.test('buildWikiManualPrompt renders the anti-name-fabrication block when a name is set', () => {
  const prompt = buildWikiManualPrompt({ userProfile: { name: 'Jeff', location: null } });
  assertStringIncludes(prompt, 'About the user');
  assertStringIncludes(prompt, 'Jeff');
  assertStringIncludes(prompt, 'NEVER invent another');
});
