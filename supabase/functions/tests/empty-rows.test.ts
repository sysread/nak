// Guards for the empty assistant-row predicate behind the end-of-turn
// sweep (venice/empty-rows.ts). Pure: no DB, no network. The
// exclusions each protect a row that is content-empty on purpose, so
// every one gets its own case - a regression here deletes real
// transcript rows.

import { assertEquals } from '@std/assert';
import { isEmptyAssistantRow, type SweepCandidate } from '../venice/empty-rows.ts';

function row(overrides: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    id: 'row-1',
    role: 'assistant',
    status: 'suspended_for_ask_user',
    content: '',
    tool_calls: null,
    reasoning: null,
    ...overrides,
  };
}

Deno.test('a parked ask_user placeholder is empty', () => {
  assertEquals(isEmptyAssistantRow(row(), null), true);
});

Deno.test('legacy null-status rows count when they carry nothing', () => {
  assertEquals(isEmptyAssistantRow(row({ status: null }), null), true);
});

Deno.test('whitespace-only content is still empty', () => {
  assertEquals(isEmptyAssistantRow(row({ content: '  \n' }), null), true);
});

Deno.test('the current turn\'s own row is never a candidate', () => {
  assertEquals(isEmptyAssistantRow(row({ id: 'keep' }), 'keep'), false);
});

Deno.test('non-assistant rows are never candidates', () => {
  assertEquals(isEmptyAssistantRow(row({ role: 'user' }), null), false);
  assertEquals(isEmptyAssistantRow(row({ role: 'tool' }), null), false);
});

Deno.test('an in-flight streaming placeholder is left alone', () => {
  assertEquals(isEmptyAssistantRow(row({ status: 'streaming' }), null), false);
});

Deno.test('a tool-round row keeps its empty content', () => {
  const calls = [{ id: 'c1', type: 'function', function: { name: 'recipe_list', arguments: '{}' } }];
  assertEquals(isEmptyAssistantRow(row({ status: null, tool_calls: calls }), null), false);
});

Deno.test('an empty tool_calls array does not rescue the row', () => {
  assertEquals(isEmptyAssistantRow(row({ tool_calls: [] }), null), true);
});

Deno.test('a reasoning-only error partial is preserved', () => {
  assertEquals(
    isEmptyAssistantRow(row({ status: 'error', reasoning: 'thought about it' }), null),
    false,
  );
});

Deno.test('a row with visible text is not empty', () => {
  assertEquals(isEmptyAssistantRow(row({ status: 'complete', content: 'hi' }), null), false);
});
