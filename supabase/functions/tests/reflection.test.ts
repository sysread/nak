// Composition guard for the reflection agent's memory toolbox.
//
// The browser used to assert this against `memoryToolbox`; that toolbox
// moved server-side when reflection migrated into the edge function, so
// the invariant lives here now. Two things are safety-critical and must
// never regress:
//
//   - The toolbox is the SOFT-decay set: memory_invalidate (halve
//     confidence) stands in for memory_delete. A background agent
//     running on its own authority must never hard-erase a memory row.
//   - ask_user is absent: reflection has no UI surface to render a
//     clarifying question to, so it must not be able to reach for it.
//
// Pure: buildReflectionToolbox() just assembles the toolbox object from
// already-registered ToolDefs, no DB or network.

import { assertEquals, assertStringIncludes } from '@std/assert';
import { __test } from '../venice/agents/reflection.ts';

Deno.test('reflection prompt instructs timeless, non-self-narrating memories', () => {
  // The writer must not bake encoding-time framing ("this session", a
  // write-date, AI self-narration) into a memory body - read back later
  // that framing reads as a current-chat event. See context-recall
  // smoothing / the librarian reshape pass that clean up legacy rows.
  const p = __test.REFLECTION_PROMPT;
  assertStringIncludes(p, 'Write memories timeless');
  assertStringIncludes(p, 'this session');
  assertStringIncludes(p, "Don't narrate yourself or the exchange");
});

Deno.test('reflection prompt does not promise a confidence bump on update', () => {
  // memory_update rewrites wording only; it does not change confidence
  // (the function-side impl never bumps). The prompt must not tell the
  // model otherwise - corroboration is memory_reaffirm's job. This pins
  // the "correct the instruction" decision over "restore a bump".
  const p = __test.REFLECTION_PROMPT;
  assertEquals(p.includes('bumps confidence'), false);
  assertStringIncludes(p, 'memory_reaffirm to nudge its confidence');
});

Deno.test('reflection toolbox is the soft-decay memory set, in declared order', () => {
  const toolbox = __test.buildReflectionToolbox();
  assertEquals(toolbox.name, 'reflection');
  assertEquals(
    toolbox.tools.map((t) => t.name),
    [
      'memory_search',
      'memory_create',
      'memory_update',
      'memory_invalidate',
      'memory_reaffirm',
      'memory_doubt',
      'memory_relate',
      'memory_unrelate',
    ],
  );
});

Deno.test('reflection toolbox excludes hard-delete and the UI tool', () => {
  const names = __test.buildReflectionToolbox().tools.map((t) => t.name);
  assertEquals(names.includes('memory_delete'), false);
  assertEquals(names.includes('ask_user'), false);
});

Deno.test('every reflection tool carries a wire schema whose name matches', () => {
  // The agent driver ships toolbox.tools[].wire to Venice; a wire whose
  // function.name disagreed with the dispatch name would 400 the round
  // or silently never match the model's call.
  for (const tool of __test.buildReflectionToolbox().tools) {
    assertEquals(tool.wire.type, 'function');
    assertEquals(tool.wire.function.name, tool.name);
  }
});
