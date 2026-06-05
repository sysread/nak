/**
 * Unit coverage for the tool-calls UI primitives. Pure functions
 * - no runes, no DOM - tested via plain vitest. The companion
 * `src/components/ToolCalls.svelte` composes these with its own
 * `expanded` per-call rune and the markup.
 */
import { describe, it, expect } from 'vitest';
import type { OpenAIToolCall } from '../src/lib/tools';
import type { Message } from '../src/lib/supabase';
import {
  activityFor,
  DEFAULT_DETAIL_VIEW,
  durationPill,
  flipDetailView,
  renderArgs,
  renderResult,
  statusFor,
  type CallTiming,
} from '../src/lib/ui/tool-calls';

function makeCall(
  id: string,
  args: string = '{}',
  name: string = 'some_tool'
): OpenAIToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
}

function makeResultMessage(content: string): Message {
  return { content } as Message;
}

describe('statusFor', () => {
  it('is pending when a timing started but has not ended and the session is streaming', () => {
    const t: Record<string, CallTiming> = { c1: { startedAt: 100 } };
    expect(statusFor('c1', t, {}, true)).toBe('pending');
  });

  it('flips to error once the session goes idle with the timing still open', () => {
    // The parent finalizes dangling timings on the streaming
    // edge, so this branch is rare in practice - but the
    // defense-in-depth case (frame between edge and finalize)
    // must not leave the spinner animating forever.
    const t: Record<string, CallTiming> = { c1: { startedAt: 100 } };
    expect(statusFor('c1', t, {}, false)).toBe('error');
  });

  it('is error when the timing carries the error flag', () => {
    const t: Record<string, CallTiming> = {
      c1: { startedAt: 100, endedAt: 200, error: true },
    };
    expect(statusFor('c1', t, {}, true)).toBe('error');
  });

  it('is ok when the timing has endedAt and no error, even with no result row yet', () => {
    // The wire tool_call_response landed (endedAt is set) and the
    // dispatcher returned a non-error outcome (error flag is unset).
    // The persisted tool-result row hasn't propagated through the
    // messages realtime subscription yet. Without trusting the
    // timing here, statusFor would fall through to the
    // sending ? 'pending' : 'error' tail and render a red X on a
    // tool that actually worked - the post-END propagation gap
    // for a non-terminal-round tool call.
    const t: Record<string, CallTiming> = {
      c1: { startedAt: 100, endedAt: 200 },
    };
    expect(statusFor('c1', t, {}, false)).toBe('ok');
    // Same answer mid-stream - the wire event is authoritative.
    expect(statusFor('c1', t, {}, true)).toBe('ok');
  });

  it('parses the result content for an error key when no timing is present', () => {
    // Replayed history path - the in-memory timings are gone but
    // the persisted tool-result row still carries the verdict.
    const results = {
      c1: makeResultMessage('{"error":"rate limited"}'),
    };
    expect(statusFor('c1', {}, results, false)).toBe('error');
  });

  it('treats non-error JSON as success', () => {
    const results = { c1: makeResultMessage('{"ok":true}') };
    expect(statusFor('c1', {}, results, false)).toBe('ok');
  });

  it('treats non-JSON content as success', () => {
    // Some tools return plain strings; we should not flag those
    // as errored just because the parse failed.
    const results = { c1: makeResultMessage('hello world') };
    expect(statusFor('c1', {}, results, false)).toBe('ok');
  });

  it('is pending when there is no timing and no result during a streaming turn', () => {
    // The brief window between the assistant message landing and
    // the first onToolStart firing.
    expect(statusFor('c1', {}, {}, true)).toBe('pending');
  });

  it('is error when there is no timing and no result and the session is idle', () => {
    // Orphan tail - stream cut off before any tool ran, or the
    // thread was opened fresh and in-memory timings were wiped.
    expect(statusFor('c1', {}, {}, false)).toBe('error');
  });
});

describe('durationPill', () => {
  it('is empty when no timing exists (replayed history)', () => {
    // Historical latency wasn't worth persisting; show the
    // status glyph only.
    expect(durationPill('c1', {}, 0)).toBe('');
  });

  it('reports the final duration once the call ended', () => {
    const t: Record<string, CallTiming> = {
      c1: { startedAt: 100, endedAt: 357 },
    };
    expect(durationPill('c1', t, 999)).toBe('257 ms');
  });

  it('reports the live elapsed against nowMs while the call is in flight', () => {
    const t: Record<string, CallTiming> = { c1: { startedAt: 100 } };
    expect(durationPill('c1', t, 850)).toBe('750 ms');
  });

  it('clamps to 0 if nowMs lags startedAt', () => {
    // Defensive: a parent that doesn't tick nowMs forward could
    // momentarily produce a negative elapsed; the pill should
    // show 0 rather than a negative-ms gotcha.
    const t: Record<string, CallTiming> = { c1: { startedAt: 100 } };
    expect(durationPill('c1', t, 50)).toBe('0 ms');
  });
});

describe('flipDetailView', () => {
  it('flips between the two modes', () => {
    expect(flipDetailView('markdown')).toBe('json');
    expect(flipDetailView('json')).toBe('markdown');
  });

  it('defaults to the readable markdown shape', () => {
    expect(DEFAULT_DETAIL_VIEW).toBe('markdown');
  });
});

describe('renderArgs', () => {
  it('wraps pretty-printed JSON in a json fence in json view', () => {
    const call = makeCall('c1', '{"a":1}');
    expect(renderArgs(call, 'json', undefined)).toBe(
      '```json\n{\n  "a": 1\n}\n```'
    );
  });

  it('defaults missing arguments to {} in json view', () => {
    const call = makeCall('c1', '');
    expect(renderArgs(call, 'json', undefined)).toBe('```json\n{}\n```');
  });

  it("falls back to a fenced block when the LLM emitted invalid JSON in json view", () => {
    // The LLM occasionally emits invalid JSON; the user still
    // needs to see what it sent.
    const call = makeCall('c1', '{a:1}');
    expect(renderArgs(call, 'json', undefined)).toBe('```json\n{a:1}\n```');
  });

  it('renders the generic markdown shape in markdown view', () => {
    const call = makeCall('c1', '{"limit":5}');
    expect(renderArgs(call, 'markdown', undefined)).toBe('- **limit:** 5');
  });

  it("prefers the tool's formatArgs override when present in markdown view", () => {
    // The override gets called with the parsed argument object
    // and its return value is the rendered markdown verbatim.
    const call = makeCall('c1', '{"x":1}');
    const formatArgs = (args: Record<string, unknown>): string =>
      'custom: ' + JSON.stringify(args);
    expect(renderArgs(call, 'markdown', { formatArgs })).toBe('custom: {"x":1}');
  });

  it('falls back to the generic formatter when an override exists but the JSON is partial', () => {
    // Mid-stream args arrive as fragments. The override expects
    // a parsed object; we should not call it with garbage. The
    // generic path renders the raw string as a fenced block.
    const call = makeCall('c1', '{"x":1');
    const formatArgs = (): string => 'should not see this';
    expect(renderArgs(call, 'markdown', { formatArgs })).toBe(
      '```\n{"x":1\n```'
    );
  });

  it('ignores the override in json view so the raw wire shape is visible', () => {
    const call = makeCall('c1', '{"x":1}');
    const formatArgs = (): string => 'should not appear';
    expect(renderArgs(call, 'json', { formatArgs })).toBe(
      '```json\n{\n  "x": 1\n}\n```'
    );
  });
});

describe('renderResult', () => {
  it('shows the in-progress placeholder when no result has landed', () => {
    expect(renderResult('c1', {}, 'markdown', undefined)).toBe('_In progress…_');
    expect(renderResult('c1', {}, 'json', undefined)).toBe('_In progress…_');
  });

  it('wraps pretty-printed JSON in a json fence in json view', () => {
    const results = { c1: makeResultMessage('{"x":1}') };
    expect(renderResult('c1', results, 'json', undefined)).toBe(
      '```json\n{\n  "x": 1\n}\n```'
    );
  });

  it('renders the generic markdown shape in markdown view', () => {
    const results = { c1: makeResultMessage('{"found":true}') };
    expect(renderResult('c1', results, 'markdown', undefined)).toBe(
      '- **found:** `true`'
    );
  });

  it("prefers the tool's formatResult override when present in markdown view", () => {
    const results = { c1: makeResultMessage('{"x":1}') };
    const formatResult = (result: unknown): string =>
      'custom: ' + JSON.stringify(result);
    expect(renderResult('c1', results, 'markdown', { formatResult })).toBe(
      'custom: {"x":1}'
    );
  });

  it('falls back to the generic formatter when an override exists but the result is not JSON', () => {
    const results = { c1: makeResultMessage('hello world') };
    const formatResult = (): string => 'should not see this';
    expect(renderResult('c1', results, 'markdown', { formatResult })).toBe(
      '```\nhello world\n```'
    );
  });
});

describe('activityFor', () => {
  it('returns the trimmed narration string when present', () => {
    const call = makeCall('c1', '{"activity":"Searching memories"}');
    expect(activityFor(call)).toBe('Searching memories');
  });

  it('trims surrounding whitespace', () => {
    const call = makeCall('c1', '{"activity":"  Searching  "}');
    expect(activityFor(call)).toBe('Searching');
  });

  it('returns null when the activity key is missing (older persisted calls)', () => {
    const call = makeCall('c1', '{"other":"value"}');
    expect(activityFor(call)).toBeNull();
  });

  it('returns null when the activity value is empty after trim', () => {
    const call = makeCall('c1', '{"activity":"   "}');
    expect(activityFor(call)).toBeNull();
  });

  it('returns null when the activity value is not a string', () => {
    const call = makeCall('c1', '{"activity":42}');
    expect(activityFor(call)).toBeNull();
  });

  it('returns null for empty arguments', () => {
    const call = makeCall('c1', '');
    expect(activityFor(call)).toBeNull();
  });

  it('returns null for partial JSON during streaming', () => {
    // The fragments arrive incrementally; an unparseable
    // half-message should not throw and should not surface a
    // false-positive activity.
    const call = makeCall('c1', '{"activity":"Searc');
    expect(activityFor(call)).toBeNull();
  });
});
