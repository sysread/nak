/**
 * Tests for runReconnectLoop and (indirectly) the shared
 * consumeStreamEvents helper that drives both the live-turn round
 * (runChatLoop) and the passive-observer round (runReconnectLoop).
 *
 * The transport is mocked at the supabase client level: a fake
 * channel exposes an `emit(event, payload)` helper that fires every
 * registered broadcast handler. The runReconnectLoop ->
 * streamReconnect path POSTs an envelope through
 * `supabase.client.functions.invoke` and then subscribes that
 * channel; tests drive the production code by emitting broadcasts
 * the function would otherwise publish.
 *
 * Sibling to tests/venice.test.ts which covers the transport itself.
 * This file covers the consumer behaviour - END routing, ask_user
 * capture, accumulator reset on stream_retry, persisted-row
 * hydration through supabase.getMessage.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
  SupabaseClient,
} from '@supabase/supabase-js';
import { runReconnectLoop, type ChatLoopHandlers } from '../src/lib/chat-loop';
import type { Message, SupabaseService } from '../src/lib/supabase';

// ---------------------------------------------------------------------------
// Channel + supabase mocks. Same shape as the helpers in
// tests/venice.test.ts; duplicated here to keep this file self-
// contained without exporting a shared test harness module.
// ---------------------------------------------------------------------------

interface MockChannel {
  readonly name: string;
  on(
    type: 'broadcast',
    opts: { event: string },
    cb: (msg: { payload: unknown }) => void,
  ): MockChannel;
  subscribe(cb?: (status: string, err?: Error) => void): MockChannel;
  send(msg: {
    type: 'broadcast';
    event: string;
    payload: unknown;
  }): Promise<RealtimeChannelSendResponse>;
  unsubscribe(): Promise<'ok' | 'error' | 'timed out'>;
  emit(event: string, payload: unknown): void;
}

function makeChannel(name: string): MockChannel {
  const handlers = new Map<string, Array<(msg: { payload: unknown }) => void>>();
  const channel: MockChannel = {
    name,
    on(_type, { event }, cb) {
      const arr = handlers.get(event) ?? [];
      arr.push(cb);
      handlers.set(event, arr);
      return channel;
    },
    subscribe(cb) {
      queueMicrotask(() => cb?.('SUBSCRIBED'));
      return channel;
    },
    async send() {
      return 'ok';
    },
    async unsubscribe() {
      return 'ok';
    },
    emit(event, payload) {
      const arr = handlers.get(event) ?? [];
      for (const cb of arr) cb({ payload });
    },
  };
  return channel;
}

interface Harness {
  channel: MockChannel;
  supabase: SupabaseService;
  getMessageMock: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  envelope: unknown;
  channelName: string;
  persistedRow?: Message | null;
  invokeError?: Error;
}): Harness {
  const channel = makeChannel(opts.channelName);
  const channels = new Map<string, MockChannel>([[channel.name, channel]]);
  const client = {
    functions: {
      invoke: vi.fn(async () => {
        if (opts.invokeError) return { data: null, error: opts.invokeError };
        return { data: opts.envelope, error: null };
      }),
    },
    channel: vi.fn((name: string) => {
      const existing = channels.get(name);
      if (existing) return existing as unknown as RealtimeChannel;
      const ch = makeChannel(name);
      channels.set(name, ch);
      return ch as unknown as RealtimeChannel;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  } as unknown as SupabaseClient;
  const getMessageMock = vi.fn(
    async (): Promise<Message | null> => opts.persistedRow ?? null,
  );
  const supabase = {
    client,
    getMessage: getMessageMock,
  } as unknown as SupabaseService;
  return { channel, supabase, getMessageMock };
}

function ctl(): AbortController {
  return new AbortController();
}

async function microtaskFlush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('runReconnectLoop', () => {
  it('returns noStreamInFlight=true when the envelope reports no in-flight stream', async () => {
    const { supabase } = makeHarness({
      channelName: 'thread:T1:stream',
      envelope: {
        channelName: 'thread:T1:stream',
        assistantRowId: null,
        completedSoFar: '',
        noStreamInFlight: true,
      },
    });
    const result = await runReconnectLoop({
      supabase,
      threadId: 'T1',
      signal: ctl().signal,
    });
    expect(result.noStreamInFlight).toBe(true);
    expect(result.finalText).toBe('');
    expect(result.interrupted).toBe(false);
    expect(result.conflictDetected).toBe(false);
    expect(result.awaitingUserAnswer).toBeNull();
  });

  it('streams text/reasoning through handlers and reports finalText on END', async () => {
    const { channel, supabase } = makeHarness({
      channelName: 'thread:T1:stream',
      envelope: {
        channelName: 'thread:T1:stream',
        assistantRowId: 'A1',
        completedSoFar: '',
      },
      persistedRow: {
        id: 'A1',
        thread_id: 'T1',
        role: 'assistant',
        content: 'hello world',
        created_at: '2026-06-04T00:00:00Z',
      },
    });
    const onTextUpdate = vi.fn();
    const onReasoningUpdate = vi.fn();
    const onAssistantPersisted = vi.fn();
    const handlers: ChatLoopHandlers = {
      onTextUpdate,
      onReasoningUpdate,
      onAssistantPersisted,
    };
    const promise = runReconnectLoop({
      supabase,
      threadId: 'T1',
      signal: ctl().signal,
      handlers,
    });
    await microtaskFlush();
    channel.emit('reasoning_text', { content: 'thinking…' });
    channel.emit('response_text', { content: 'hello ' });
    channel.emit('response_text', { content: 'world' });
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    const result = await promise;
    expect(result.finalText).toBe('hello world');
    expect(result.interrupted).toBe(false);
    expect(result.noStreamInFlight).toBe(false);
    // Cumulative deltas: each onTextUpdate carries the full text so far,
    // mirroring the chat-loop's contract.
    expect(onTextUpdate.mock.calls.map((c) => c[0])).toEqual([
      'hello ',
      'hello world',
    ]);
    expect(onReasoningUpdate).toHaveBeenCalledWith('thinking…');
    // Persisted-row hydration runs after END so the slot's replay
    // buffer carries the canonical row.
    expect(onAssistantPersisted).toHaveBeenCalledTimes(1);
    expect(onAssistantPersisted.mock.calls[0][0].content).toBe('hello world');
  });

  it('routes END(aborted) into interrupted=true', async () => {
    const { channel, supabase } = makeHarness({
      channelName: 'thread:T1:stream',
      envelope: {
        channelName: 'thread:T1:stream',
        assistantRowId: 'A1',
        completedSoFar: '',
      },
    });
    const promise = runReconnectLoop({
      supabase,
      threadId: 'T1',
      signal: ctl().signal,
    });
    await microtaskFlush();
    channel.emit('response_text', { content: 'partial' });
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'aborted',
    });
    const result = await promise;
    expect(result.interrupted).toBe(true);
    expect(result.finalText).toBe('partial');
  });

  it('routes END(error) with a conflict reason into conflictDetected=true (no throw)', async () => {
    const { channel, supabase } = makeHarness({
      channelName: 'thread:T1:stream',
      envelope: {
        channelName: 'thread:T1:stream',
        assistantRowId: 'A1',
        completedSoFar: '',
      },
    });
    const promise = runReconnectLoop({
      supabase,
      threadId: 'T1',
      signal: ctl().signal,
    });
    await microtaskFlush();
    channel.emit('END', {
      persistedAssistantId: '',
      terminalKind: 'error',
      conflict: 'a newer user message landed first',
    });
    const result = await promise;
    expect(result.conflictDetected).toBe(true);
    expect(result.interrupted).toBe(false);
  });

  it('clears accumulators on stream_retry so the next attempt starts clean', async () => {
    const { channel, supabase } = makeHarness({
      channelName: 'thread:T1:stream',
      envelope: {
        channelName: 'thread:T1:stream',
        assistantRowId: 'A1',
        completedSoFar: '',
      },
    });
    const onTextUpdate = vi.fn();
    const onReasoningUpdate = vi.fn();
    const promise = runReconnectLoop({
      supabase,
      threadId: 'T1',
      signal: ctl().signal,
      handlers: { onTextUpdate, onReasoningUpdate },
    });
    await microtaskFlush();
    channel.emit('reasoning_text', { content: 'reasoning…' });
    channel.emit('response_text', { content: 'first attempt' });
    channel.emit('stream_retry', { reason: 'truncated', attempt: 1 });
    channel.emit('response_text', { content: 'second attempt' });
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    const result = await promise;
    expect(result.finalText).toBe('second attempt');
    // After stream_retry, accumulators reset to '' and the handlers
    // get a synthetic empty-string callback so the throttle's pending
    // buffers don't replay the discarded prefix.
    expect(onTextUpdate).toHaveBeenCalledWith('first attempt');
    expect(onTextUpdate).toHaveBeenCalledWith('');
    expect(onTextUpdate).toHaveBeenLastCalledWith('second attempt');
    expect(onReasoningUpdate).toHaveBeenCalledWith('reasoning…');
    expect(onReasoningUpdate).toHaveBeenCalledWith('');
  });

  it('forwards tool_call_response broadcasts to onToolDone (paired by id)', async () => {
    const { channel, supabase } = makeHarness({
      channelName: 'thread:T1:stream',
      envelope: {
        channelName: 'thread:T1:stream',
        assistantRowId: 'A1',
        completedSoFar: '',
      },
    });
    const onToolStart = vi.fn();
    const onToolDone = vi.fn();
    const promise = runReconnectLoop({
      supabase,
      threadId: 'T1',
      signal: ctl().signal,
      handlers: { onToolStart, onToolDone },
    });
    await microtaskFlush();
    channel.emit('tool_call_request', {
      request: { id: 'call_abc', name: 'memory_search', args: { q: 'x' } },
    });
    channel.emit('tool_call_response', {
      id: 'call_abc',
      name: 'memory_search',
      result_summary: '[3 hits]',
    });
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    await promise;
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolStart.mock.calls[0][0].id).toBe('call_abc');
    expect(onToolStart.mock.calls[0][0].function.name).toBe('memory_search');
    expect(onToolDone).toHaveBeenCalledTimes(1);
    // Same OpenAIToolCall object the onToolStart received, paired by id.
    expect(onToolDone.mock.calls[0][0].id).toBe('call_abc');
    expect(onToolDone.mock.calls[0][1]).toBe('[3 hits]');
  });

  it('drops a tool_call_response with no matching prior tool_call_request', async () => {
    const { channel, supabase } = makeHarness({
      channelName: 'thread:T1:stream',
      envelope: {
        channelName: 'thread:T1:stream',
        assistantRowId: 'A1',
        completedSoFar: '',
      },
    });
    const onToolDone = vi.fn();
    const promise = runReconnectLoop({
      supabase,
      threadId: 'T1',
      signal: ctl().signal,
      handlers: { onToolDone },
    });
    await microtaskFlush();
    channel.emit('tool_call_response', {
      id: 'call_orphan',
      name: 'memory_search',
      result_summary: '[?]',
    });
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    await promise;
    expect(onToolDone).not.toHaveBeenCalled();
  });
});
