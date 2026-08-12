// Windowing guards for venice/tools/conversation_get.ts.
//
// The regression these exist for: a caller searched for a conversation,
// correctly identified a 107-message thread, opened it twice, and both
// times received the last eight turns - while the content it needed was
// message 1. The tool reported `truncated: true` and offered no way to
// reach anything else, so the only move left was to re-call with the
// same id and get identical bytes.
//
// Pure: no DB, no network.

import { assert, assertEquals } from '@std/assert';
import { __test } from '../venice/tools/conversation_get.ts';

const { bestMatchIndex, readableTurns, windowTranscript, MAX_TRANSCRIPT_CHARS } = __test;

/** A thread of `n` turns, each big enough that only a few fit a window. */
function longThread(n: number, overrides: Record<number, string> = {}) {
  const per = Math.floor(MAX_TRANSCRIPT_CHARS / 8);
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: overrides[i] ?? `turn ${i} ${'x'.repeat(per)}`,
  }));
}

// --- turn selection -------------------------------------------------------

Deno.test('readableTurns drops tool rows and empty assistant rows', () => {
  const turns = readableTurns([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '' },
    { role: 'tool', content: '{"big":"json"}' },
    { role: 'assistant', content: 'hi' },
    { role: 'assistant', content: null },
  ]);
  assertEquals(turns.map((t) => t.content), ['hello', 'hi']);
});

// --- match anchoring ------------------------------------------------------

Deno.test('bestMatchIndex ranks by distinct terms matched, not repetition', () => {
  const turns = readableTurns([
    { role: 'user', content: 'lentils lentils lentils lentils lentils' },
    { role: 'user', content: 'I soaked them in cider because I had no lentils' },
  ]);
  assertEquals(bestMatchIndex(turns, 'cider soak lentils'), 1);
});

Deno.test('bestMatchIndex prefers the earlier turn on a tie', () => {
  // Where a topic is introduced usually explains it better than where
  // it is echoed back later.
  const turns = readableTurns([
    { role: 'user', content: 'ran out of lentils' },
    { role: 'assistant', content: 'ran out of lentils, understood' },
  ]);
  assertEquals(bestMatchIndex(turns, 'lentils'), 0);
});

Deno.test('bestMatchIndex ignores noise terms and reports no match honestly', () => {
  const turns = readableTurns([{ role: 'user', content: 'bread' }]);
  // Sub-3-character tokens are dropped, so a query of only stopwords
  // has nothing to match on.
  assertEquals(bestMatchIndex(turns, 'a of to'), -1);
  assertEquals(bestMatchIndex(turns, 'lentils cider'), -1);
});

// --- windowing ------------------------------------------------------------

Deno.test('without a query the window is the tail, as it always was', () => {
  const out = windowTranscript(longThread(40));
  assertEquals(out.truncated, true);
  assertEquals(out.window.total, 40);
  assertEquals(out.window.end, 39);
  assert(out.window.start > 0);
});

Deno.test('an anchored window reaches the head of a long thread', () => {
  // The exact failure: the answer is message 0 of a long thread and the
  // tail window can never show it.
  const rows = longThread(107, { 0: 'I ran out of lentils so I soaked them in cider' });
  const anchor = bestMatchIndex(readableTurns(rows), 'lentils cider soak');
  assertEquals(anchor, 0);

  const anchored = windowTranscript(rows, anchor);
  assert(anchored.messages[0].content.includes('ran out of lentils'));
  assertEquals(anchored.window.start, 0);

  // And the un-anchored window demonstrably does NOT contain it, which
  // is what made retrying pointless.
  const tail = windowTranscript(rows);
  assert(!tail.messages.some((m) => m.content.includes('ran out of lentils')));
});

Deno.test('an anchored window carries the exchange around the match', () => {
  const rows = longThread(107, { 50: 'the cider soak replaced the lentils' });
  const out = windowTranscript(rows, 50);
  assert(out.window.start < 50, 'should reach back before the match');
  assert(out.window.end > 50, 'should reach forward past the match');
  assert(out.messages.some((m) => m.content.includes('cider soak')));
});

Deno.test('window position is reported so truncated is actionable', () => {
  const out = windowTranscript(longThread(107), 50);
  assertEquals(out.window.total, 107);
  assert(out.window.start >= 0 && out.window.end < 107);
  assertEquals(out.truncated, true);
  // The reported slice length matches what was actually returned -
  // a caller doing arithmetic on these numbers must not be misled.
  assertEquals(out.messages.length, out.window.end - out.window.start + 1);
});

Deno.test('a thread that fits entirely is not reported as truncated', () => {
  const rows = [
    { role: 'user', content: 'short' },
    { role: 'assistant', content: 'also short' },
  ];
  for (const anchor of [-1, 0, 1]) {
    const out = windowTranscript(rows, anchor);
    assertEquals(out.truncated, false);
    assertEquals(out.messages.length, 2);
    assertEquals(out.window, { start: 0, end: 1, total: 2 });
  }
});

Deno.test('windowing an empty thread does not blow up', () => {
  const out = windowTranscript([{ role: 'tool', content: 'dropped' }]);
  assertEquals(out.messages, []);
  assertEquals(out.window.total, 0);
  assertEquals(out.truncated, false);
});

Deno.test('a single oversized turn still comes back', () => {
  // Losing the only turn to a budget check would report an empty
  // conversation for a thread that plainly has content.
  const rows = [{ role: 'user', content: 'y'.repeat(MAX_TRANSCRIPT_CHARS * 3) }];
  for (const anchor of [-1, 0]) {
    const out = windowTranscript(rows, anchor);
    assertEquals(out.messages.length, 1);
    assertEquals(out.window.total, 1);
  }
});
