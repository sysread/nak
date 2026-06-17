/**
 * Tests for the shared `consumeStreamEvents` helper - the consumer that
 * turns the function's StreamEvent stream into slot-handler calls plus
 * the ChatLoopResult fields. It drives the live turn (runChatLoop) and
 * lives in src/lib/chat/stream-events.ts.
 *
 * The transport (Broadcast channel -> StreamEvent mapping) is covered by
 * tests/venice.test.ts. This file feeds consumeStreamEvents a hand-rolled
 * async iterable of already-mapped StreamEvents and asserts the consumer
 * behaviour: text/reasoning accumulation, END routing (completed /
 * aborted / error+conflict), accumulator resets on stream_retry and the
 * per-round round_committed boundary, tool_call_response pairing, and
 * persisted-row hydration through supabase.getMessage.
 */
import { describe, it, expect, vi } from 'vitest';
import { consumeStreamEvents } from '../src/lib/chat/stream-events';
import type { ChatLoopHandlers } from '../src/lib/chat/types';
import { VeniceError, type StreamEvent } from '../src/lib/venice';
import type { Message, SupabaseService } from '../src/lib/supabase';

// Async iterable from a fixed list, with a microtask between yields so
// the consumer's awaits (getMessage on round_committed / END) interleave
// the way they would against a real channel queue.
function eventsOf(list: StreamEvent[]): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of list) {
        yield ev;
        await Promise.resolve();
      }
    },
  };
}

// Minimal SupabaseService stand-in: consumeStreamEvents only ever calls
// getMessage (round-boundary + terminal hydration).
function makeSupabase(
  getMessage: (id: string) => Promise<Message | null>,
): { supabase: SupabaseService; getMessageMock: ReturnType<typeof vi.fn> } {
  const getMessageMock = vi.fn(getMessage);
  const supabase = { getMessage: getMessageMock } as unknown as SupabaseService;
  return { supabase, getMessageMock };
}

function row(id: string, content: string): Message {
  return {
    id,
    thread_id: 'T1',
    role: 'assistant',
    content,
    created_at: '2026-06-06T00:00:00Z',
  } as Message;
}

function run(
  events: StreamEvent[],
  supabase: SupabaseService,
  handlers?: ChatLoopHandlers,
): ReturnType<typeof consumeStreamEvents> {
  return consumeStreamEvents({
    events: eventsOf(events),
    signal: new AbortController().signal,
    supabase,
    handlers,
  });
}

describe('consumeStreamEvents', () => {
  it('accumulates text/reasoning, reports finalText, and hydrates the persisted row on END', async () => {
    const { supabase, getMessageMock } = makeSupabase(async () =>
      row('A1', 'hello world'),
    );
    const onTextUpdate = vi.fn();
    const onReasoningUpdate = vi.fn();
    const onAssistantPersisted = vi.fn();
    const result = await run(
      [
        { type: 'reasoning', delta: 'thinking…' },
        { type: 'text', delta: 'hello ' },
        { type: 'text', delta: 'world' },
        { type: 'end', persistedAssistantId: 'A1', terminalKind: 'completed', roundsRun: 1 },
      ],
      supabase,
      { onTextUpdate, onReasoningUpdate, onAssistantPersisted },
    );
    expect(result.finalText).toBe('hello world');
    expect(result.interrupted).toBe(false);
    expect(result.conflictDetected).toBe(false);
    // Cumulative deltas: each onTextUpdate carries the full text so far.
    expect(onTextUpdate.mock.calls.map((c) => c[0])).toEqual([
      'hello ',
      'hello world',
    ]);
    expect(onReasoningUpdate).toHaveBeenCalledWith('thinking…');
    expect(getMessageMock).toHaveBeenCalledWith('A1');
    expect(onAssistantPersisted).toHaveBeenCalledTimes(1);
    expect(onAssistantPersisted.mock.calls[0][0].content).toBe('hello world');
  });

  it('routes END(aborted) into interrupted=true', async () => {
    const { supabase } = makeSupabase(async () => null);
    const result = await run(
      [
        { type: 'text', delta: 'partial' },
        { type: 'end', persistedAssistantId: 'A1', terminalKind: 'aborted', roundsRun: 1 },
      ],
      supabase,
    );
    expect(result.interrupted).toBe(true);
    expect(result.finalText).toBe('partial');
  });

  it('routes END(error) with a conflict reason into conflictDetected=true (no throw)', async () => {
    const { supabase } = makeSupabase(async () => null);
    const result = await run(
      [
        {
          type: 'end',
          persistedAssistantId: '',
          terminalKind: 'error',
          roundsRun: 1,
          conflict: 'a newer user message landed first',
        },
      ],
      supabase,
    );
    expect(result.conflictDetected).toBe(true);
    expect(result.interrupted).toBe(false);
  });

  it('hydrates the cut-off partial then throws on a terminal error event', async () => {
    // The server persists whatever streamed (here reasoning-only) as a
    // status='error' row and publishes END carrying its id AFTER the
    // 'error' event. The consumer must hand that row to its card
    // (onAssistantPersisted) before throwing, so the partial survives
    // the browser's error path instead of vanishing.
    const partial = {
      ...row('ERR1', ''),
      reasoning: 'half a thought',
      status: 'error' as const,
    };
    const { supabase, getMessageMock } = makeSupabase(async () => partial);
    const onAssistantPersisted = vi.fn();
    await expect(
      run(
        [
          { type: 'reasoning', delta: 'half a thought' },
          { type: 'error', kind: 'internal', message: 'boom', retryable: false },
          {
            type: 'end',
            persistedAssistantId: 'ERR1',
            terminalKind: 'error',
            roundsRun: 1,
          },
        ],
        supabase,
        { onAssistantPersisted },
      ),
    ).rejects.toThrow('boom');
    // Hydration ran (END was not dropped) and the partial card landed
    // before the throw.
    expect(getMessageMock).toHaveBeenCalledWith('ERR1');
    expect(onAssistantPersisted).toHaveBeenCalledTimes(1);
    expect(onAssistantPersisted.mock.calls[0][0].id).toBe('ERR1');
  });

  it('preserves the rate_limit kind when stashing the terminal error', async () => {
    // runExchange parks a retry closure only on a VeniceError whose
    // kind is 'rate_limit'; deferring the throw must not flatten it.
    const { supabase } = makeSupabase(async () => row('ERR2', 'partial'));
    let caught: unknown;
    try {
      await run(
        [
          { type: 'text', delta: 'partial' },
          { type: 'error', kind: 'rate_limit', message: 'overloaded', retryable: true },
          {
            type: 'end',
            persistedAssistantId: 'ERR2',
            terminalKind: 'error',
            roundsRun: 1,
          },
        ],
        supabase,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VeniceError);
    expect((caught as VeniceError).kind).toBe('rate_limit');
  });

  it('clears accumulators on stream_retry so the next attempt starts clean', async () => {
    const { supabase } = makeSupabase(async () => row('A1', 'second attempt'));
    const onTextUpdate = vi.fn();
    const onReasoningUpdate = vi.fn();
    const result = await run(
      [
        { type: 'reasoning', delta: 'reasoning…' },
        { type: 'text', delta: 'first attempt' },
        { type: 'stream_retry', reason: 'truncated', attempt: 1 },
        { type: 'text', delta: 'second attempt' },
        { type: 'end', persistedAssistantId: 'A1', terminalKind: 'completed', roundsRun: 1 },
      ],
      supabase,
      { onTextUpdate, onReasoningUpdate },
    );
    expect(result.finalText).toBe('second attempt');
    // After stream_retry the accumulators reset to '' and the handlers
    // get a synthetic empty-string callback so the discarded prefix
    // doesn't replay.
    expect(onTextUpdate).toHaveBeenCalledWith('first attempt');
    expect(onTextUpdate).toHaveBeenCalledWith('');
    expect(onTextUpdate).toHaveBeenLastCalledWith('second attempt');
    expect(onReasoningUpdate).toHaveBeenCalledWith('reasoning…');
    expect(onReasoningUpdate).toHaveBeenCalledWith('');
  });

  it('resets accumulators and hands off the row on a round boundary (round_committed)', async () => {
    const round0 = row('ROUND0', 'round-0 text');
    const terminal = row('A1', 'final answer');
    const { supabase, getMessageMock } = makeSupabase(async (id) =>
      id === 'ROUND0' ? round0 : id === 'A1' ? terminal : null,
    );
    const onTextUpdate = vi.fn();
    const onAssistantPersisted = vi.fn();
    const result = await run(
      [
        { type: 'reasoning', delta: 'round-0 reasoning' },
        { type: 'text', delta: 'round-0 text' },
        { type: 'round_committed', id: 'ROUND0' },
        { type: 'text', delta: 'final answer' },
        { type: 'end', persistedAssistantId: 'A1', terminalKind: 'completed', roundsRun: 2 },
      ],
      supabase,
      { onTextUpdate, onAssistantPersisted },
    );
    // finalText is the terminal round's text alone, not round0 + round1.
    expect(result.finalText).toBe('final answer');
    expect(getMessageMock).toHaveBeenCalledWith('ROUND0');
    // Boundary hand-off (ROUND0) then terminal hydration (A1), in order.
    expect(onAssistantPersisted.mock.calls.map((c) => c[0].id)).toEqual([
      'ROUND0',
      'A1',
    ]);
    // Post-boundary text carries only round 1's text - before the
    // round_committed reset this read 'round-0 textfinal answer'.
    expect(onTextUpdate.mock.calls.map((c) => c[0])).toEqual([
      'round-0 text',
      'final answer',
    ]);
  });

  it('forwards tool_call_response to onToolDone, paired by id', async () => {
    const { supabase } = makeSupabase(async () => null);
    const onToolStart = vi.fn();
    const onToolDone = vi.fn();
    await run(
      [
        {
          type: 'tool_call',
          toolCall: {
            id: 'call_abc',
            type: 'function',
            function: { name: 'memory_search', arguments: '{}' },
          },
        },
        {
          type: 'tool_call_response',
          id: 'call_abc',
          name: 'memory_search',
          ok: true,
          resultSummary: '[3 hits]',
        },
        { type: 'end', persistedAssistantId: '', terminalKind: 'completed', roundsRun: 1 },
      ],
      supabase,
      { onToolStart, onToolDone },
    );
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolStart.mock.calls[0][0].id).toBe('call_abc');
    expect(onToolDone).toHaveBeenCalledTimes(1);
    expect(onToolDone.mock.calls[0][0].id).toBe('call_abc');
    expect(onToolDone.mock.calls[0][1]).toBe('[3 hits]');
  });

  it('drops a tool_call_response with no matching prior tool_call', async () => {
    const { supabase } = makeSupabase(async () => null);
    const onToolDone = vi.fn();
    await run(
      [
        {
          type: 'tool_call_response',
          id: 'call_orphan',
          name: 'memory_search',
          ok: true,
          resultSummary: '[?]',
        },
        { type: 'end', persistedAssistantId: '', terminalKind: 'completed', roundsRun: 1 },
      ],
      supabase,
      { onToolDone },
    );
    expect(onToolDone).not.toHaveBeenCalled();
  });
});
