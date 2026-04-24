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
import { sanitizeToolCallsForWire } from '../src/lib/tools/wire';
import type { OpenAIToolCall } from '../src/lib/tools/types';

function mkCall(args: string, id = 'call_x', name = 'memory_search'): OpenAIToolCall {
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
      mkCall('{"query":"a"}', 'call_a'),
      mkCall('{"activity": "broken "string", "q": 1}', 'call_b'),
      mkCall('', 'call_c'),
    ];
    const out = sanitizeToolCallsForWire(calls);
    expect(out[0].function.arguments).toBe('{"query":"a"}');
    expect(out[1].function.arguments).toBe('{}');
    expect(out[2].function.arguments).toBe('{}');
  });

  it('preserves id, type and function.name when rewriting arguments', () => {
    const bad = mkCall('{not json', 'call_keep_id', 'memory_create');
    const out = sanitizeToolCallsForWire([bad]);
    expect(out[0].id).toBe('call_keep_id');
    expect(out[0].type).toBe('function');
    expect(out[0].function.name).toBe('memory_create');
    expect(out[0].function.arguments).toBe('{}');
  });
});
