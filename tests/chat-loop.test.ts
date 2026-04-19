/**
 * Chat-loop orchestration tests.
 *
 * The loop composes a lot of moving parts (streaming SSE, tool
 * dispatch, Supabase persistence), so we stub each collaborator to a
 * minimal fake and assert on the loop's observable behavior:
 *   - right messages persisted in the right order
 *   - concurrent tool execution (not serialized)
 *   - toggle_tools flipping state mid-loop
 *   - abort cascading through child tool signals
 *   - MAX_ROUNDS guardrail
 */
import { describe, it, expect, vi } from 'vitest';
import { runChatLoop, MAX_ROUNDS, toVeniceMessage } from '../src/lib/chat-loop';
import type { ChatRequest, StreamEvent } from '../src/lib/venice';
import type { VeniceClient } from '../src/lib/venice';
import type { SupabaseService, Thread, Message } from '../src/lib/supabase';
import type { OpenAIToolCall } from '../src/lib/tools';

function mkThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't-1',
    user_id: 'u-1',
    title: 'Test',
    model: null,
    reasoning_effort: null,
    tools_enabled: false,
    created_at: 'now',
    updated_at: 'now',
    ...overrides,
  };
}

function mkCall(name: string, args: object = {}, id = `call_${name}`): OpenAIToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Record-shaped mock for SupabaseService. Captures every addMessage call
 * so tests can assert the persistence sequence, and lets individual
 * tests override methods (e.g. to simulate tool behavior on memory
 * tools).
 */
interface MockSupabase {
  addMessage: ReturnType<typeof vi.fn>;
  setThreadToolsEnabled: ReturnType<typeof vi.fn>;
  searchMemories: ReturnType<typeof vi.fn>;
  searchMemoriesByEmbedding: ReturnType<typeof vi.fn>;
  searchUnembeddedMemoriesByText: ReturnType<typeof vi.fn>;
  createMemory: ReturnType<typeof vi.fn>;
  updateMemory: ReturnType<typeof vi.fn>;
  deleteMemory: ReturnType<typeof vi.fn>;
}

function mockSupabase(overrides: Partial<MockSupabase> = {}): {
  svc: SupabaseService;
  mocks: MockSupabase;
  messagesOut: Message[];
} {
  const messagesOut: Message[] = [];
  let nextId = 0;
  const mocks: MockSupabase = {
    addMessage: vi.fn(async (threadId: string, role: Message['role'], content: string, opts: Record<string, unknown> = {}) => {
      const m: Message = {
        id: `m-${++nextId}`,
        thread_id: threadId,
        role,
        content,
        created_at: String(Date.now()),
        tool_calls: (opts.tool_calls as Message['tool_calls']) ?? undefined,
        tool_call_id: (opts.tool_call_id as Message['tool_call_id']) ?? undefined,
        name: (opts.name as Message['name']) ?? undefined,
        model: (opts.model as Message['model']) ?? undefined,
        usage: (opts.usage as Message['usage']) ?? undefined,
      };
      messagesOut.push(m);
      return m;
    }),
    setThreadToolsEnabled: vi.fn(async () => undefined),
    searchMemories: vi.fn(async () => []),
    searchMemoriesByEmbedding: vi.fn(async () => []),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
    createMemory: vi.fn(async (label: string, data: string) => ({
      id: 'mem-1',
      label,
      data,
      created_at: 't',
      updated_at: 't',
    })),
    updateMemory: vi.fn(async (id: string) => ({
      id,
      label: 'x',
      data: 'y',
      created_at: 't',
      updated_at: 't',
    })),
    deleteMemory: vi.fn(async () => undefined),
    ...overrides,
  };
  return { svc: mocks as unknown as SupabaseService, mocks, messagesOut };
}

/**
 * Build a VeniceClient whose streamChat yields the configured events for
 * round N on its Nth invocation. Used to script a multi-round
 * conversation. `sleepBetween` inserts an awaited microtask between
 * events so concurrency can be observed in tests.
 */
function mockVenice(roundEvents: StreamEvent[][]): VeniceClient {
  let i = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
      const events = roundEvents[i++] ?? [];
      for (const ev of events) {
        // Yield on a microtask so the consuming loop's state updates
        // interleave with delta emission — closer to real streaming.
        await Promise.resolve();
        yield ev;
      }
    },
    // memory_search embeds its query before running the similarity RPC;
    // any test that drives a non-empty search through the loop hits this.
    // A fixed-length zero vector keeps the shape honest without caring
    // about the contents.
    embed: vi.fn(async () => ({
      data: [{ index: 0, embedding: new Array(1024).fill(0) }],
    })),
  } as unknown as VeniceClient;
}

describe('toVeniceMessage', () => {
  it('projects a plain user/assistant row', () => {
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'user',
      content: 'hi',
      created_at: 't',
    };
    expect(toVeniceMessage(m)).toEqual({ role: 'user', content: 'hi' });
  });

  it('projects an assistant-with-tool-calls row', () => {
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'assistant',
      content: '',
      created_at: 't',
      tool_calls: [mkCall('memory_search')],
    };
    const out = toVeniceMessage(m);
    expect(out.tool_calls).toHaveLength(1);
    expect(out.role).toBe('assistant');
  });

  it('projects a tool-result row with id and name', () => {
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'tool',
      content: '{"ok":true}',
      created_at: 't',
      tool_call_id: 'call_x',
      name: 'memory_search',
    };
    expect(toVeniceMessage(m)).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call_x',
      name: 'memory_search',
    });
  });
});

describe('runChatLoop', () => {
  it('forwards reasoningEffort to every streamChat call', async () => {
    // The loop doesn't gate on ModelSpec.supportsReasoning — that's the
    // caller's job. So whatever reasoningEffort is passed in rides along
    // on every round.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      reasoningEffort: 'medium',
    });
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].reasoningEffort).toBe('medium');
  });

  it('leaves reasoningEffort unset on streamChat when the caller omits it', async () => {
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });
    expect(seenRequests[0].reasoningEffort).toBeUndefined();
  });

  it('persists a plain text response in one round', async () => {
    const venice = mockVenice([
      [{ type: 'text', delta: 'Hello' }, { type: 'text', delta: ' there' }],
    ]);
    const { svc, messagesOut } = mockSupabase();
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });
    expect(result.finalText).toBe('Hello there');
    expect(result.roundsRun).toBe(1);
    expect(result.stoppedByLimit).toBe(false);
    expect(messagesOut).toHaveLength(1);
    expect(messagesOut[0]).toMatchObject({ role: 'assistant', content: 'Hello there' });
  });

  it('runs a round of tool calls then a final text round', async () => {
    const call = mkCall('memory_search', { query: 'cat' });
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: call }],
      [{ type: 'text', delta: 'You have a cat named Whiskers.' }],
    ]);
    const { svc, mocks, messagesOut } = mockSupabase({
      // memory_search with a non-empty query now runs vector search;
      // route the hit through the embedding-backed path.
      searchMemoriesByEmbedding: vi.fn(async () => [
        { id: 'mem-1', label: 'cat', data: 'Whiskers', created_at: 't', updated_at: 't' },
      ]),
    });
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ tools_enabled: true }),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'what is my cat named?' }],
      signal: new AbortController().signal,
    });
    expect(result.finalText).toBe('You have a cat named Whiskers.');
    expect(result.roundsRun).toBe(2);
    // Persisted order: assistant-with-tool-calls, tool result, final assistant
    expect(messagesOut.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(messagesOut[0].tool_calls).toHaveLength(1);
    expect(messagesOut[1].tool_call_id).toBe(call.id);
    expect(messagesOut[1].name).toBe('memory_search');
    expect(mocks.searchMemoriesByEmbedding).toHaveBeenCalledOnce();
  });

  it('executes parallel tool calls concurrently', async () => {
    const calls = [mkCall('memory_search', {}, 'c0'), mkCall('memory_search', {}, 'c1')];
    const venice = mockVenice([
      calls.map((c) => ({ type: 'tool_call' as const, toolCall: c })),
      [{ type: 'text', delta: 'done' }],
    ]);
    // Each searchMemories call sleeps 50ms. If calls were serialized the
    // round would take ~100ms; concurrent execution keeps it near 50ms.
    const { svc } = mockSupabase({
      searchMemories: vi.fn(
        () => new Promise((r) => setTimeout(() => r([]), 50))
      ),
    });
    const start = Date.now();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ tools_enabled: true }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - start;
    // Generous upper bound — CI latency adds jitter, but serial would
    // be ~100ms+ which clears 85ms with headroom.
    expect(elapsed).toBeLessThan(85);
  });

  it('flips tools_enabled when the model calls toggle_tools', async () => {
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: mkCall('toggle_tools', { enable: true }) }],
      [{ type: 'text', delta: 'Tools are ready.' }],
    ]);
    const { svc, mocks } = mockSupabase();
    const changes: boolean[] = [];
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: {
        onToolsEnabledChange: (enabled) => changes.push(enabled),
      },
    });
    expect(result.toolsEnabled).toBe(true);
    expect(changes).toEqual([true]);
    expect(mocks.setThreadToolsEnabled).toHaveBeenCalledWith('t-1', true);
  });

  it('surfaces a tool error via onToolError and as a tool-result row', async () => {
    const call = mkCall('memory_search', {});
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: call }],
      [{ type: 'text', delta: 'sorry, failed' }],
    ]);
    const { svc, messagesOut } = mockSupabase({
      searchMemories: vi.fn(async () => {
        throw new Error('db is down');
      }),
    });
    const errors: Error[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ tools_enabled: true }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: {
        onToolError: (_c, err) => errors.push(err),
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/db is down/);
    // The tool-result row carries a JSON-encoded error payload, so the
    // model sees structured failure rather than a stringified Error.
    const toolMsg = messagesOut.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/db is down/);
    expect(JSON.parse(toolMsg!.content)).toEqual({ error: 'db is down' });
  });

  it('stops at MAX_ROUNDS if the model never produces a terminal response', async () => {
    // Every round is a tool call — the model never gives up.
    const rounds: StreamEvent[][] = [];
    for (let i = 0; i < MAX_ROUNDS + 2; i++) {
      rounds.push([
        {
          type: 'tool_call',
          toolCall: mkCall('memory_search', {}, `c${i}`),
        },
      ]);
    }
    const venice = mockVenice(rounds);
    const { svc } = mockSupabase();
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ tools_enabled: true }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
    });
    expect(result.stoppedByLimit).toBe(true);
    expect(result.roundsRun).toBe(MAX_ROUNDS);
  });

  it('fires onTextUpdate with cumulative round text', async () => {
    const venice = mockVenice([
      [
        { type: 'text', delta: 'He' },
        { type: 'text', delta: 'llo' },
        { type: 'text', delta: '!' },
      ],
    ]);
    const { svc } = mockSupabase();
    const updates: string[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: { onTextUpdate: (t) => updates.push(t) },
    });
    expect(updates).toEqual(['He', 'Hello', 'Hello!']);
  });

  it('invokes onAssistantPersisted and onToolResultPersisted in order', async () => {
    const call = mkCall('memory_search', {});
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: call }],
      [{ type: 'text', delta: 'final' }],
    ]);
    const { svc } = mockSupabase();
    const order: string[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ tools_enabled: true }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: {
        onAssistantPersisted: () => order.push('assistant'),
        onToolResultPersisted: () => order.push('tool'),
      },
    });
    expect(order).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('persists model id and usage on a plain text assistant row', async () => {
    const venice = mockVenice([
      [
        { type: 'text', delta: 'hi' },
        {
          type: 'usage',
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      ],
    ]);
    const { svc, messagesOut } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'kimi-k2-5',
      history: [],
      signal: new AbortController().signal,
    });
    expect(messagesOut).toHaveLength(1);
    expect(messagesOut[0].model).toBe('kimi-k2-5');
    expect(messagesOut[0].usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
  });

  it('persists model id and usage on an assistant-with-tool-calls row', async () => {
    // Tool-call turns burn tokens too; the indicator should be able to
    // reflect that even though the content-less assistant row won't
    // surface the ring in the UI.
    const call = mkCall('memory_search', {});
    const venice = mockVenice([
      [
        { type: 'tool_call', toolCall: call },
        {
          type: 'usage',
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        },
      ],
      [{ type: 'text', delta: 'done' }],
    ]);
    const { svc, messagesOut } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ tools_enabled: true }),
      userId: 'u-1',
      modelId: 'arcee-trinity-large-thinking',
      history: [],
      signal: new AbortController().signal,
    });
    const firstAssistant = messagesOut.find(
      (m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0
    );
    expect(firstAssistant?.model).toBe('arcee-trinity-large-thinking');
    expect(firstAssistant?.usage?.total_tokens).toBe(110);
  });

  it('leaves usage undefined when the stream skipped the epilogue', async () => {
    const venice = mockVenice([[{ type: 'text', delta: 'hi' }]]);
    const { svc, messagesOut } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'kimi-k2-5',
      history: [],
      signal: new AbortController().signal,
    });
    expect(messagesOut[0].model).toBe('kimi-k2-5');
    // The chat-loop passes `usage: null` when no epilogue arrived; the
    // mock's `?? undefined` fallback normalizes that to undefined,
    // matching how a freshly-inserted row would deserialize.
    expect(messagesOut[0].usage).toBeUndefined();
  });

  it('handles malformed JSON arguments as a tool error', async () => {
    const bogus: OpenAIToolCall = {
      id: 'c0',
      type: 'function',
      function: { name: 'memory_search', arguments: '{not json' },
    };
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: bogus }],
      [{ type: 'text', delta: 'ok' }],
    ]);
    const { svc, messagesOut } = mockSupabase();
    const errors: Error[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ tools_enabled: true }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: { onToolError: (_c, err) => errors.push(err) },
    });
    expect(errors).toHaveLength(1);
    const toolMsg = messagesOut.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    // A parse failure still produces a tool-result row so the history
    // stays valid for a future replay.
    expect(JSON.parse(toolMsg!.content)).toHaveProperty('error');
  });
});
