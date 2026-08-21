// Wire-name sanitization guards. Replayed transcripts carry the tool
// names the original turn persisted - including MCP-routed names
// (`mcp:<integrationId>:<serverToolName>`) whose colons strict Venice
// backends 400 on when no `tools` array declares them. The agent
// sub-completions (curation, recall) replay history with no tools
// declared, so every projection must route names through
// sanitizeToolNameForWire. These tests pin the sanitizer's contract
// and the two projection sites that carry names onto the wire.
//
// Pure: no DB, no network, no Supabase env.

import { assert, assertEquals } from '@std/assert';
import {
  sanitizeToolCallsForWire,
  sanitizeToolNameForWire,
} from '../venice/agents/_wire.ts';
import { messageToWire } from '../venice/agents/_curation_helpers.ts';
import {
  messageToVenice,
  type StoredMessage,
} from '../venice/agents/_recall_helpers.ts';

Deno.test('sanitizeToolNameForWire passes a valid name through unchanged', () => {
  assertEquals(sanitizeToolNameForWire('memory_search'), 'memory_search');
  assertEquals(sanitizeToolNameForWire('web-search_2'), 'web-search_2');
});

Deno.test('sanitizeToolNameForWire replaces MCP colons and stays deterministic', () => {
  const mcp = 'mcp:0b8f3c1a-7e4d-4a2b-9c5e-1f2a3b4c5d6e:list_events';
  const out = sanitizeToolNameForWire(mcp);
  assert(/^[a-zA-Z0-9_-]{1,64}$/.test(out), `sanitized name still invalid: ${out}`);
  // Deterministic: the assistant call and the paired tool row must
  // land at the same value from independent call sites.
  assertEquals(sanitizeToolNameForWire(mcp), out);
});

Deno.test('sanitizeToolNameForWire truncates to 64 and never returns empty', () => {
  const long = `mcp:id:${'x'.repeat(100)}`;
  assert(sanitizeToolNameForWire(long).length <= 64);
  assertEquals(sanitizeToolNameForWire('::'), '__');
});

Deno.test('sanitizeToolCallsForWire rewrites invalid function names', () => {
  const calls = [
    {
      id: 'abc123def',
      type: 'function' as const,
      function: { name: 'mcp:uuid:tool', arguments: '{"q":1}' },
    },
  ];
  const out = sanitizeToolCallsForWire(calls);
  assert(/^[a-zA-Z0-9_-]{1,64}$/.test(out[0].function.name));
});

Deno.test('curation and recall projections agree on the sanitized pair', () => {
  // The assistant row's call name and the tool row's `name` must land
  // at the same sanitized value through BOTH projections, or the
  // replayed fan-in reads as mismatched.
  const name = 'mcp:0b8f3c1a-7e4d-4a2b-9c5e-1f2a3b4c5d6e:list_events';
  const asst: StoredMessage = {
    id: 'a1',
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'abc123def', type: 'function', function: { name, arguments: '{}' } },
    ],
    tool_call_id: null,
    name: null,
  };
  const toolRow: StoredMessage = {
    id: 't1',
    role: 'tool',
    content: '{"ok":true}',
    tool_calls: null,
    tool_call_id: 'abc123def',
    name,
  };
  const viaCuration = [messageToWire(asst), messageToWire(toolRow)];
  const viaRecall = [messageToVenice(asst), messageToVenice(toolRow)];
  for (const pair of [viaCuration, viaRecall]) {
    const callName = pair[0].tool_calls?.[0]?.function.name;
    const rowName = (pair[1] as { name?: string }).name;
    assert(callName !== undefined && callName === rowName);
    assert(/^[a-zA-Z0-9_-]{1,64}$/.test(rowName ?? ''));
  }
  // Cross-projection agreement too - a transcript can be assembled by
  // one path and re-read by the other.
  assertEquals(
    viaCuration[0].tool_calls?.[0]?.function.name,
    viaRecall[0].tool_calls?.[0]?.function.name,
  );
});
