/**
 * Tests for the shared tool-call wire-projection helpers in
 * `src/lib/tools/wire.ts`.
 *
 * The sanitiser used to live inline in chat-loop.ts; it was hoisted to
 * a leaf module so every wire-projection site (chat-loop's
 * toVeniceMessage and in-loop history push, the headless tool loop in
 * tools/run.ts, and every agent's messageToVenice helper) can call in
 * without dragging chat-loop along. The chat-loop tests still cover
 * the toVeniceMessage path; these tests cover the sanitiser directly
 * so a regression there isn't only visible through one of the call
 * sites.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
} from '../src/lib/tools/wire';
import type { OpenAIToolCall } from '../src/lib/tools/types';

function mkCall(
  args: string,
  id = 'abcdefghi',
  name = 'memory_search'
): OpenAIToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

describe('sanitizeToolCallsForWire', () => {
  // The Venice 400 we are guarding against:
  //   "Expecting ',' delimiter: line 1 column 42 (char 41)"
  // Triggered by an unescaped quote inside the model-written `activity`
  // sentence (see ACTIVITY_PARAM_SCHEMA in tools/dispatch.ts). The bad
  // arguments blob would ride every subsequent replay until the row
  // dropped out of history, blocking every turn on the affected thread.
  it('replaces malformed JSON arguments with "{}"', () => {
    const bad = mkCall(
      '{"activity": "Searching your memories for "dishwasher" notes", "query": "x"}'
    );
    const out = sanitizeToolCallsForWire([bad]);
    expect(out).toHaveLength(1);
    expect(out[0].function.arguments).toBe('{}');
    // Original call is left untouched - the DB / UI copy should still
    // show what the model tried to emit.
    expect(bad.function.arguments).toContain('dishwasher');
  });

  it('canonicalises well-formed arguments through parse + restringify', () => {
    const call = mkCall('{ "query" : "dishwasher" }');
    const out = sanitizeToolCallsForWire([call]);
    expect(out[0].function.arguments).toBe('{"query":"dishwasher"}');
  });

  it('treats an empty arguments string as "{}"', () => {
    const call = mkCall('');
    const out = sanitizeToolCallsForWire([call]);
    expect(out[0].function.arguments).toBe('{}');
  });

  it('returns the same object reference when no normalisation is needed', () => {
    // Already-canonical JSON parses+restringifies to the same string,
    // so the sanitiser short-circuits and returns the original call.
    // This matters because the wire array is downstream of the DB row;
    // unnecessary cloning would inflate worker GC pressure on long
    // threads.
    const call = mkCall('{"query":"dishwasher"}');
    const out = sanitizeToolCallsForWire([call]);
    expect(out[0]).toBe(call);
  });

  it('processes each call in a multi-call array independently', () => {
    const calls: OpenAIToolCall[] = [
      mkCall('{"query":"a"}', 'aaaaaaaaa'),
      mkCall('{"activity": "broken "string", "q": 1}', 'bbbbbbbbb'),
      mkCall('', 'ccccccccc'),
    ];
    const out = sanitizeToolCallsForWire(calls);
    expect(out[0].function.arguments).toBe('{"query":"a"}');
    expect(out[1].function.arguments).toBe('{}');
    expect(out[2].function.arguments).toBe('{}');
  });

  it('preserves type and function.name when rewriting arguments', () => {
    // Use an already-conforming id so this test stays focused on the
    // arguments-string sanitiser - the id sanitiser has its own block
    // below.
    const bad = mkCall('{not json', 'abcdefghi', 'memory_create');
    const out = sanitizeToolCallsForWire([bad]);
    expect(out[0].id).toBe('abcdefghi');
    expect(out[0].type).toBe('function');
    expect(out[0].function.name).toBe('memory_create');
    expect(out[0].function.arguments).toBe('{}');
  });

  // The Venice 400 we are guarding against here:
  //   "Tool call id was call_a031 but must be a-z, A-Z, 0-9, with a
  //    length of 9."
  // Some Venice-routed model backends generate ids of that shape
  // themselves and then 400 the next request that echoes them back. The
  // sanitiser rewrites the id to a stable 9-char alphanumeric string so
  // the assistant tool_calls[].id and the matching tool message's
  // tool_call_id can be paired without tripping the validator.
  it('rewrites a tool-call id that violates the wire pattern', () => {
    const call = mkCall('{}', 'call_a031');
    const out = sanitizeToolCallsForWire([call]);
    expect(out[0].id).not.toBe('call_a031');
    expect(out[0].id).toMatch(/^[a-zA-Z0-9]{9}$/);
  });
});

describe('sanitizeToolCallIdForWire', () => {
  it('passes already-conforming ids through unchanged', () => {
    expect(sanitizeToolCallIdForWire('abcdefghi')).toBe('abcdefghi');
    expect(sanitizeToolCallIdForWire('Z9aB7cD2e')).toBe('Z9aB7cD2e');
  });

  it('rewrites ids with non-alphanumeric chars', () => {
    const out = sanitizeToolCallIdForWire('call_a031');
    expect(out).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(out).not.toBe('call_a031');
  });

  it('rewrites ids that are not exactly 9 chars long', () => {
    expect(sanitizeToolCallIdForWire('abc')).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(sanitizeToolCallIdForWire('abcdefghij')).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(sanitizeToolCallIdForWire('call_abc123def456')).toMatch(
      /^[a-zA-Z0-9]{9}$/
    );
  });

  it('is deterministic - the same input always maps to the same output', () => {
    // Load-bearing property: the assistant tool_calls[].id and the
    // matching tool result row's tool_call_id MUST land at the same
    // string after sanitisation, or OpenAI-compatible providers reject
    // the message list.
    const a = sanitizeToolCallIdForWire('call_a031');
    const b = sanitizeToolCallIdForWire('call_a031');
    expect(a).toBe(b);
  });

  it('is idempotent - sanitising twice gives the same result', () => {
    const once = sanitizeToolCallIdForWire('call_a031');
    const twice = sanitizeToolCallIdForWire(once);
    expect(twice).toBe(once);
  });

  it('maps distinct nearby ids to distinct outputs', () => {
    // Within a single conversation turn we see at most a handful of
    // tool calls; their ids from Venice differ by a digit or two. The
    // sanitiser has to keep them distinct after rewriting or two tool
    // results will collapse onto one assistant call.
    const ids = ['call_a031', 'call_a032', 'call_a033', 'call_b031'];
    const outs = ids.map(sanitizeToolCallIdForWire);
    expect(new Set(outs).size).toBe(ids.length);
  });
});
