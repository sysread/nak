/**
 * Unit coverage for ReflectionAgent — the class, not the worker. The
 * worker-layer state machine (claim → run agent → mark) lives in
 * `./loop.ts` and gets its own test file.
 *
 * What we verify here: the agent correctly fetches a thread's
 * history, slices it at the claimed terminal message, appends the
 * reflection prompt as the final user turn, and threads the result
 * from `runHeadlessToolLoop` back into the `AgentRunResult` shape.
 * Signal handling and error surfacing are the two other
 * transitions — both return well-formed AgentRunResult objects so
 * callers never need a try/catch at the boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import { ReflectionAgent } from '../src/lib/agents/reflection/agent';
import { REFLECTION_PROMPT } from '../src/lib/agents/reflection/prompt';
import { memoryToolbox } from '../src/lib/tools';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type { VeniceClient, VeniceMessage, StreamEvent } from '../src/lib/venice';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'm',
    thread_id: 't-1',
    role: 'user',
    content: 'hi',
    created_at: '2024-01-01T00:00:00Z',
    tool_calls: null,
    tool_call_id: null,
    name: null,
    model: null,
    usage: null,
    ...overrides,
  } as Message;
}

/**
 * Build a SupabaseService stub with just the methods ReflectionAgent
 * touches. `listMessages` resolves with whatever `messages` was
 * assembled to; tool calls made by the agent are captured on
 * `toolCalls` if the test triggers any.
 */
function makeSupabase(messages: Message[]): {
  svc: SupabaseService;
  spies: {
    listMessages: ReturnType<typeof vi.fn>;
    createMemory: ReturnType<typeof vi.fn>;
    decayMemoryConfidence: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    listMessages: vi.fn(async () => messages),
    // The reflection agent's toolbox might reach into these via the
    // memory tools; keep them safe defaults so a stray call doesn't
    // blow up in the tests that don't care.
    createMemory: vi.fn(async (label: string, data: string) => ({
      id: 'mem-1',
      label,
      data,
      created_at: 't',
      updated_at: 't',
    })),
    decayMemoryConfidence: vi.fn(async () => 0.5),
    searchMemories: vi.fn(async () => []),
    searchMemoriesByEmbedding: vi.fn(async () => []),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

/**
 * Scripted venice whose `streamChat` yields a canned StreamEvent[]
 * per round. `streamCalls` captures every call's messages so tests
 * can inspect what the agent composed.
 */
function makeVenice(rounds: StreamEvent[][]): {
  venice: VeniceClient;
  streamCalls: VeniceMessage[][];
} {
  const remaining = rounds.slice();
  const streamCalls: VeniceMessage[][] = [];
  const streamChat = vi.fn(
    (req: { messages: VeniceMessage[] }): AsyncGenerator<StreamEvent, void, void> => {
      streamCalls.push(req.messages.map((m) => ({ ...m })));
      const events = remaining.shift() ?? [];
      async function* gen(): AsyncGenerator<StreamEvent, void, void> {
        for (const ev of events) yield ev;
      }
      return gen();
    }
  );
  return {
    venice: { streamChat, embed: vi.fn(async () => ({ data: [] })) } as unknown as VeniceClient,
    streamCalls,
  };
}

describe('ReflectionAgent — identity + contract', () => {
  it('advertises the reflection toolbox, reflection name, and a model id', () => {
    const { svc } = makeSupabase([]);
    const { venice } = makeVenice([]);
    const agent = new ReflectionAgent(venice, svc);
    expect(agent.name).toBe('reflection');
    expect(agent.toolbox).toBe(memoryToolbox);
    expect(agent.model.length).toBeGreaterThan(0);
  });

  it('accepts a model override for tests and future A/B runs', () => {
    const { svc } = makeSupabase([]);
    const { venice } = makeVenice([]);
    const agent = new ReflectionAgent(venice, svc, 'custom-test-model');
    expect(agent.model).toBe('custom-test-model');
  });
});

describe('ReflectionAgent — run() happy path', () => {
  it('fetches history, slices at terminalMsgId, appends REFLECTION_PROMPT, and reports a done result', async () => {
    // Thread has three messages; terminal is the middle one. The
    // slice must include the terminal but exclude the newer turn the
    // user added mid-reflection.
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'Hi, I love cats', created_at: '2024-01-01T00:00:00Z' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'Cats are great.', created_at: '2024-01-01T00:00:01Z' }),
      makeMessage({ id: 'u2', role: 'user', content: 'and also dogs', created_at: '2024-01-01T00:00:02Z' }),
    ];
    const { svc } = makeSupabase(messages);
    const { venice, streamCalls } = makeVenice([[{ type: 'text', delta: 'done' }]]);
    const agent = new ReflectionAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('done');
    expect(result.output.finalText).toBe('done');
    expect(result.output.inputMessageCount).toBe(2); // u1, a1 — the 'u2' turn excluded
    expect(result.toolCalls).toBe(0);

    // The messages the model saw on round 1: u1, a1, then the
    // REFLECTION_PROMPT appended as a user turn. The later 'u2'
    // message the user added mid-reflection must not be present.
    const round1 = streamCalls[0];
    expect(round1).toHaveLength(3);
    expect(round1[0].content).toContain('I love cats');
    expect(round1[1].content).toContain('Cats are great');
    expect(round1[2].role).toBe('user');
    expect(round1[2].content).toBe(REFLECTION_PROMPT);
    // Ensure the mid-reflection user turn didn't leak in.
    expect(round1.some((m) => m.content === 'and also dogs')).toBe(false);
  });

  it('counts tool calls the agent issued during reflection', async () => {
    // Model asks for one memory_create, then a terminal text round.
    // We expect toolCalls=1 on the AgentRunResult.
    const { svc, spies } = makeSupabase([
      makeMessage({ id: 'u1', role: 'user', content: 'My birthday is in June.' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'Got it.' }),
    ]);
    const { venice } = makeVenice([
      [
        {
          type: 'tool_call',
          toolCall: {
            id: 'c1',
            type: 'function',
            function: {
              name: 'memory_create',
              arguments: JSON.stringify({ label: 'birthday', data: 'June' }),
            },
          },
        },
      ],
      [{ type: 'text', delta: 'ok' }],
    ]);
    const agent = new ReflectionAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
    });

    expect(result.toolCalls).toBe(1);
    // createMemory now accepts an optional third `confidence` arg; the
    // reflection-side caller leaves it undefined so the schema default
    // (1.0) applies - see src/lib/tools/memory_create.ts.
    expect(spies.createMemory).toHaveBeenCalledWith('birthday', 'June', undefined);
  });
});

describe('ReflectionAgent — edge cases', () => {
  it('handles a missing terminalMsgId by using the whole fetched history', async () => {
    // If the claimed terminal somehow isn't found (concurrent thread
    // edits, say), we fall back to "all messages" rather than
    // returning empty — partial reflection is better than no
    // reflection at all.
    const messages = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];
    const { svc } = makeSupabase(messages);
    const { venice } = makeVenice([[{ type: 'text', delta: 'x' }]]);
    const agent = new ReflectionAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'nonexistent-id' },
      userId: 'u',
    });

    expect(result.output.inputMessageCount).toBe(2);
    expect(result.stoppedReason).toBe('done');
  });

  it('returns done with zero work when the thread has no messages', async () => {
    const { svc } = makeSupabase([]);
    const { venice } = makeVenice([]);
    const agent = new ReflectionAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'whatever' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('done');
    expect(result.output.inputMessageCount).toBe(0);
    expect(venice.streamChat).not.toHaveBeenCalled();
  });

  it('short-circuits on a pre-aborted signal without calling Supabase or Venice', async () => {
    const { svc } = makeSupabase([makeMessage({ id: 'a1', role: 'assistant', content: 'x' })]);
    const { venice } = makeVenice([]);
    const agent = new ReflectionAgent(venice, svc, 'test-model');
    const ac = new AbortController();
    ac.abort();

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
      signal: ac.signal,
    });

    expect(result.stoppedReason).toBe('aborted');
    expect(svc.listMessages).not.toHaveBeenCalled();
    expect(venice.streamChat).not.toHaveBeenCalled();
  });

  it('captures a thrown error and returns stoppedReason=error with a message', async () => {
    const svc = {
      listMessages: vi.fn(async () => {
        throw new Error('network flaked');
      }),
    } as unknown as SupabaseService;
    const { venice } = makeVenice([]);
    const agent = new ReflectionAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('error');
    expect(result.error).toMatch(/network flaked/);
    expect(result.output.finalText).toBe('');
    expect(result.toolCalls).toBe(0);
  });

  it('projects stored tool-call history onto VeniceMessage shape when the thread had tool rounds', async () => {
    // A thread that included a tool round: assistant row with
    // tool_calls, then a tool-result row. Both must be mapped
    // correctly so the reflection model sees the history in its
    // native OpenAI shape.
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'search my notes' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'memory_search', arguments: '{}' },
          },
        ],
      }),
      makeMessage({
        id: 't1',
        role: 'tool',
        content: JSON.stringify([{ id: 'x', label: 'y', data: 'z' }]),
        tool_call_id: 'tc1',
        name: 'memory_search',
      }),
      makeMessage({ id: 'a2', role: 'assistant', content: 'here you go' }),
    ];
    const { svc } = makeSupabase(messages);
    const { venice, streamCalls } = makeVenice([[{ type: 'text', delta: 'ok' }]]);
    const agent = new ReflectionAgent(venice, svc, 'test-model');

    await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a2' },
      userId: 'u',
    });

    const round1 = streamCalls[0];
    // Find the assistant-with-tool-calls row and verify tool_calls
    // landed on the wire (round-trip invariant: history → API is
    // direct projection).
    const toolRow = round1.find((m) => m.role === 'tool');
    expect(toolRow?.tool_call_id).toBe('tc1');
    expect(toolRow?.name).toBe('memory_search');
    const asstRow = round1.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(asstRow?.tool_calls?.[0].id).toBe('tc1');
  });
});
