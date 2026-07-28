// Coverage for the memory body-length budget: the non-growth rule's
// tiering and the per-row hints the librarians read.
//
// The tiering is the graded half of the shrink signal. A flat "shorten
// long memories" instruction would push the librarian to rewrite healthy
// short rows, so the boundaries and the "no hint at all when a row is
// fine" contract are both pinned here.

import { assertEquals, assertStringIncludes } from '@std/assert';
import {
  MAX_MEMORY_DATA_CHARS,
  memoryLengthHint,
  memoryLengthTier,
} from '../venice/tools/_memory_data_budget.ts';

Deno.test('length tiers: at/under budget is ok, up to 2x is trim, beyond is condense', () => {
  assertEquals(memoryLengthTier(0), 'ok');
  assertEquals(memoryLengthTier(500), 'ok');
  assertEquals(memoryLengthTier(MAX_MEMORY_DATA_CHARS), 'ok');
  assertEquals(memoryLengthTier(MAX_MEMORY_DATA_CHARS + 1), 'trim');
  assertEquals(memoryLengthTier(MAX_MEMORY_DATA_CHARS * 2), 'trim');
  assertEquals(memoryLengthTier(MAX_MEMORY_DATA_CHARS * 2 + 1), 'condense');
});

// Absence of a hint is how "this row is fine, do not spend a rewrite on
// it" reaches the librarian. If this ever starts returning a string for
// a healthy row, every short memory in the store grows a nudge.
Deno.test('a row within budget gets no hint at all', () => {
  assertEquals(memoryLengthHint(500), null);
  assertEquals(memoryLengthHint(MAX_MEMORY_DATA_CHARS), null);
});

Deno.test('hints state the actual length - the model cannot count characters by eye', () => {
  const trim = memoryLengthHint(3200);
  const condense = memoryLengthHint(7000);
  assertStringIncludes(trim ?? '', '3200');
  assertStringIncludes(condense ?? '', '7000');
});

// The two tiers must read differently or the grading is decorative: a
// 'trim' row is only worth touching opportunistically, a 'condense' row
// earns a pass on its own.
Deno.test('trim defers to an in-flight rewrite; condense justifies its own', () => {
  const trim = memoryLengthHint(3200) ?? '';
  const condense = memoryLengthHint(7000) ?? '';
  assertStringIncludes(trim, 'anyway');
  assertStringIncludes(trim, 'Not worth a rewrite on its own');
  assertStringIncludes(condense, 'worth a rewrite for its own sake');
});

// Shrink pressure on a row whose every sentence carries a distinct fact
// would otherwise push the model to drop facts to hit the number, which
// is exactly what memory_reshape's contract forbids.
Deno.test('both hints repeat the no-fact-loss rule', () => {
  assertStringIncludes(memoryLengthHint(3200) ?? '', 'Never drop a fact');
  assertStringIncludes(memoryLengthHint(7000) ?? '', 'losing facts is worse');
});
