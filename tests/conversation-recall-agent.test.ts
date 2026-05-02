/**
 * Unit coverage for ConversationRecallAgent — the class, not the tool
 * that invokes it. Parallels `recall-agent.test.ts` on the memory
 * side; we cover the pieces that differ (conversationRecallToolbox
 * pinned instead of recallToolbox, topic suffix in the prompt) more
 * aggressively, and the shared pieces (trim, parse, abort, error)
 * once each.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConversationRecallAgent } from '../src/lib/agents/conversation_recall/agent';
import {
  CONVERSATION_RECALL_PROMPT,
  buildConversationRecallPrompt,
} from '../src/lib/agents/conversation_recall/prompt';
import { conversationRecallToolbox } from '../src/lib/tools/conversation_recall_toolbox';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type {
  ChatCompletion,
  OpenAIToolCall,
  VeniceClient,
  VeniceMessage,
} from '../src/lib/venice';

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

function makeSupabase(messages: Message[]): {
  svc: SupabaseService;
  spies: { listMessages: ReturnType<typeof vi.fn> };
} {
  const spies = {
    listMessages: vi.fn(async () => messages),
    // `conversation_search` is the only tool in the toolbox. The
    // search + hydrate stubs are present so a round that routes
    // through the tool doesn't blow up — we don't assert on them
    // here, recall tests just want to pin the agent's shape.
    searchThreads: vi.fn(async () => []),
    listThreadSummariesByIds: vi.fn(async () => []),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

interface RecordedStreamCall {
  messages: VeniceMessage[];
  responseFormat: unknown;
  toolNames: string[];
}

interface RoundScript {
  text?: string;
  toolCalls?: OpenAIToolCall[];
}

function makeVenice(rounds: RoundScript[]): {
  venice: VeniceClient;
  streamCalls: RecordedStreamCall[];
} {
  const remaining = rounds.slice();
  const streamCalls: RecordedStreamCall[] = [];
  const completeChat = vi.fn(
    async (req: {
      messages: VeniceMessage[];
      responseFormat?: unknown;
      tools?: Array<{ function: { name: string } }>;
    }): Promise<ChatCompletion> => {
      streamCalls.push({
        messages: req.messages.map((m) => ({ ...m })),
        responseFormat: req.responseFormat,
        toolNames: (req.tools ?? []).map((t) => t.function.name),
      });
      const script = remaining.shift() ?? {};
      return {
        text: script.text ?? '',
        reasoning: '',
        toolCalls: script.toolCalls ?? [],
        usage: null,
        citations: [],
        finishReason: (script.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop',
      };
    }
  );
  return {
    venice: {
      completeChat,
      // conversation_search embeds the query before hitting
      // searchThreads. A 1024-dim zero vector satisfies padding math.
      embed: vi.fn(async () => ({
        data: [{ index: 0, embedding: new Array(1024).fill(0) }],
      })),
    } as unknown as VeniceClient,
    streamCalls,
  };
}

describe('buildConversationRecallPrompt', () => {
  it('returns the base prompt when no topic is provided', () => {
    expect(buildConversationRecallPrompt()).toBe(CONVERSATION_RECALL_PROMPT);
    expect(buildConversationRecallPrompt(null)).toBe(CONVERSATION_RECALL_PROMPT);
    expect(buildConversationRecallPrompt('')).toBe(CONVERSATION_RECALL_PROMPT);
    // Whitespace-only is treated as "no topic" — the suffix would
    // read as "flagged this topic specifically:   " and the agent
    // would chase a spurious hint.
    expect(buildConversationRecallPrompt('   ')).toBe(CONVERSATION_RECALL_PROMPT);
  });

  it('appends the topic suffix when a non-empty topic is provided', () => {
    const withTopic = buildConversationRecallPrompt('moving to Lisbon');
    expect(withTopic.startsWith(CONVERSATION_RECALL_PROMPT)).toBe(true);
    expect(withTopic).toMatch(/flagged this topic specifically: moving to Lisbon/);
  });

  it('trims whitespace around the topic before appending', () => {
    const withTopic = buildConversationRecallPrompt('  the dissertation chapter  ');
    expect(withTopic).toMatch(/: the dissertation chapter$/);
  });
});

describe('ConversationRecallAgent — identity + contract', () => {
  it('pins the conversation-recall toolbox, advertises the right name + a model id', () => {
    const { svc } = makeSupabase([]);
    const { venice } = makeVenice([]);
    const agent = new ConversationRecallAgent(venice, svc);
    expect(agent.name).toBe('conversation-recall');
    expect(agent.toolbox).toBe(conversationRecallToolbox);
    expect(agent.model.length).toBeGreaterThan(0);
  });

  it('advertises only conversation_search — no write tools, no memory tools', () => {
    const toolNames = conversationRecallToolbox.tools.map((t) => t.name);
    expect(toolNames).toEqual(['conversation_search']);
  });

  it('accepts a model override for tests', () => {
    const { svc } = makeSupabase([]);
    const { venice } = makeVenice([]);
    const agent = new ConversationRecallAgent(venice, svc, 'custom-test-model');
    expect(agent.model).toBe('custom-test-model');
  });
});

describe('ConversationRecallAgent — run() happy path', () => {
  it('trims the in-flight assistant tool_calls row, appends the prompt, pins json_object, and parses a note', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'we were talking about dinner' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'Got any cuisines in mind?' }),
      makeMessage({ id: 'u2', role: 'user', content: 'something Italian' }),
      // The in-flight assistant row that triggered the recall tool.
      // trimToLastUserTurn hides it from the wire history; without
      // the trim, Venice rejects the unanswered tool_calls shape.
      makeMessage({
        id: 'a2',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'conversation_recall', arguments: '{}' },
          },
        ],
      }),
    ];
    const { svc } = makeSupabase(messages);
    const { venice, streamCalls } = makeVenice([
      {
        text: '{"kind":"note","note":"I remember the user prefers cacio e pepe when they pick Italian."}',
      },
    ]);
    const agent = new ConversationRecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('done');
    expect(result.output.note).toEqual({
      kind: 'note',
      note: 'I remember the user prefers cacio e pepe when they pick Italian.',
    });
    expect(result.output.inputMessageCount).toBe(3);

    const call = streamCalls[0];
    expect(call.messages).toHaveLength(4);
    expect(call.messages[call.messages.length - 1]).toEqual({
      role: 'user',
      content: CONVERSATION_RECALL_PROMPT,
    });
    expect(call.messages.some((m) => m.tool_calls && m.tool_calls.length > 0)).toBe(false);
    expect(call.responseFormat).toEqual({ type: 'json_object' });
    // Read-only toolbox — only conversation_search on the wire.
    expect(call.toolNames).toEqual(['conversation_search']);
  });

  it('appends the topic hint to the prompt when provided', async () => {
    // The topic suffix is what moves the agent from "infer what the
    // user cares about" to "I know the specific phrase to search
    // first" — testing that the hint actually reaches the prompt is
    // the only way to catch a regression where the agent silently
    // drops it.
    const { svc } = makeSupabase([
      makeMessage({ id: 'u1', role: 'user', content: 'same topic as before' }),
    ]);
    const { venice, streamCalls } = makeVenice([{ text: '{"kind":"none"}' }]);
    const agent = new ConversationRecallAgent(venice, svc, 'test-model');

    await agent.run({
      input: { threadId: 't-1', topic: 'moving to Lisbon' },
      userId: 'u',
    });

    const lastMsg = streamCalls[0].messages[streamCalls[0].messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toMatch(/flagged this topic specifically: moving to Lisbon/);
  });

  it('returns an empty-kind note when the model emits the no-op signal', async () => {
    const { svc } = makeSupabase([
      makeMessage({ id: 'u1', role: 'user', content: 'what time is it' }),
    ]);
    const { venice } = makeVenice([{ text: '{"kind":"none"}' }]);
    const agent = new ConversationRecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.output.note).toEqual({ kind: 'none' });
    expect(result.output.rawText).toBe('{"kind":"none"}');
  });

  it('falls back to {kind:"none"} when the model returns malformed JSON', async () => {
    const { svc } = makeSupabase([
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
    ]);
    const { venice } = makeVenice([
      { text: 'I could not recall anything relevant.' },
    ]);
    const agent = new ConversationRecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('done');
    expect(result.output.note).toEqual({ kind: 'none' });
    expect(result.output.rawText).toBe('I could not recall anything relevant.');
  });
});

describe('ConversationRecallAgent — edge cases', () => {
  it('short-circuits on a pre-aborted signal without calling Supabase or Venice', async () => {
    const { svc } = makeSupabase([
      makeMessage({ id: 'u1', role: 'user', content: 'x' }),
    ]);
    const { venice } = makeVenice([]);
    const agent = new ConversationRecallAgent(venice, svc, 'test-model');
    const ac = new AbortController();
    ac.abort();

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
      signal: ac.signal,
    });

    expect(result.stoppedReason).toBe('aborted');
    expect(svc.listMessages).not.toHaveBeenCalled();
    expect(venice.completeChat).not.toHaveBeenCalled();
  });

  it('returns done with an empty note when no user turn is in the thread', async () => {
    const { svc } = makeSupabase([
      makeMessage({ id: 'a1', role: 'assistant', content: 'auto-greet' }),
    ]);
    const { venice } = makeVenice([]);
    const agent = new ConversationRecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('done');
    expect(result.output.note).toEqual({ kind: 'none' });
    expect(result.output.inputMessageCount).toBe(0);
    expect(venice.completeChat).not.toHaveBeenCalled();
  });

  it('captures a thrown error and returns stoppedReason=error with a message', async () => {
    const svc = {
      listMessages: vi.fn(async () => {
        throw new Error('network flaked');
      }),
    } as unknown as SupabaseService;
    const { venice } = makeVenice([]);
    const agent = new ConversationRecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('error');
    expect(result.error).toMatch(/network flaked/);
    expect(result.output.note).toEqual({ kind: 'none' });
  });
});
