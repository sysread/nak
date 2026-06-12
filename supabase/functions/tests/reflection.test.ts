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

import { assertEquals } from '@std/assert';
import { __test } from '../venice/agents/reflection.ts';

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
