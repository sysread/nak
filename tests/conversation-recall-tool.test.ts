/**
 * Unit coverage for the `conversation_recall` tool. Light layer — the
 * agent itself is tested in `conversation-recall-agent.test.ts`. Here
 * we check the tool surface:
 *
 *   - present in the main chat TOOLS list (model can see it);
 *   - absent from memoryToolbox, recallToolbox, and
 *     conversationRecallToolbox (no recall-inside-recall recursion);
 *   - description prefers recall over conversation_search for
 *     context-gathering (load-bearing for the model's judgement);
 *   - execute() routes through ConversationRecallAgent, forwards the
 *     topic arg into the agent input, and hands the parsed note back
 *     as the tool result.
 *   - agent errors don't surface as thrown tool errors — collapse to
 *     `{kind:'none'}` same as memory_recall.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  memoryToolbox,
  recallToolbox,
  conversationRecallToolbox,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import { conversationRecall } from '../src/lib/tools/conversation_recall';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type { ChatCompletion, VeniceClient, VeniceMessage } from '../src/lib/venice';

function makeCompletion(text: string): ChatCompletion {
  return {
    text,
    reasoning: '',
    toolCalls: [],
    usage: null,
    citations: [],
    finishReason: 'stop',
  };
}

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

function ctxFor(svc: SupabaseService, venice: VeniceClient): ToolContext {
  return {
    supabase: svc,
    venice,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

describe('conversation_recall — registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('conversation_recall');
  });

  it('is absent from memoryToolbox', () => {
    expect(memoryToolbox.tools.map((t) => t.name)).not.toContain('conversation_recall');
  });

  it('is absent from recallToolbox', () => {
    expect(recallToolbox.tools.map((t) => t.name)).not.toContain('conversation_recall');
  });

  it('is absent from conversationRecallToolbox — no recursion', () => {
    // A recall agent that could call conversation_recall would spin
    // up another recall agent from inside itself. The design
    // explicitly forbids this; the test is the tripwire.
    expect(conversationRecallToolbox.tools.map((t) => t.name)).not.toContain(
      'conversation_recall'
    );
  });

  it('description scopes recall vs search by use case', () => {
    // The earlier "PREFER recall over conversation_search" wording was
    // dropped when conversation_search moved to always-on. The two
    // tools are peers now: conversation_recall is the topic-boundary
    // pre-pass (returns a digested note); conversation_search is the
    // raw-results path for explicit user lookups. The description has
    // to spell out both halves so the model picks the right tool.
    expect(conversationRecall.description).toMatch(/recall/i);
    expect(conversationRecall.description).toMatch(/conversation_search/);
    // Topic-boundary cue - the lever that scopes recall over a direct
    // search.
    expect(conversationRecall.description).toMatch(/topic|every turn|context/i);
  });

  it('declares a topic parameter (optional), nothing else', () => {
    // Keeping the parameter schema minimal means the model can't
    // pass a wrong thread id — threadId flows through ctx.
    expect(conversationRecall.parameters).toEqual({
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: expect.any(String),
        },
      },
      additionalProperties: false,
    });
  });
});

describe('conversation_recall — execute() routes through ConversationRecallAgent', () => {
  it('returns the parsed note on the happy path', async () => {
    // The agent's chat-completion seam moved to supabase.complete in
    // milestone 6; the ctx.venice handle is still threaded through
    // because the agent constructor takes it, but the loop no longer
    // drives it. Script the completion on the supabase fixture.
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'remind me what we picked for dinner' }),
    ];
    const listMessages = vi.fn(async () => messages);
    const complete = vi.fn(async () =>
      makeCompletion(
        '{"kind":"note","note":"I remember we settled on cacio e pepe last time we did Italian."}'
      )
    );
    const svc = { listMessages, complete } as unknown as SupabaseService;
    const venice = {
      completeChat: vi.fn(),
      embed: vi.fn(),
    } as unknown as VeniceClient;

    const result = await conversationRecall.execute({}, ctxFor(svc, venice));

    expect(result).toEqual({
      kind: 'note',
      note: 'I remember we settled on cacio e pepe last time we did Italian.',
    });
    expect(listMessages).toHaveBeenCalledWith('t-1');
  });

  it('forwards the topic arg into the agent\u2019s prompt', async () => {
    // The topic string should reach the final user turn the agent
    // sends to the function. Intercept supabase.complete and grep for
    // the topic in the last message.
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'pick up where we left off' }),
    ];

    const seen: VeniceMessage[][] = [];
    const complete = vi.fn(async (req: { messages: VeniceMessage[] }) => {
      seen.push(req.messages);
      return makeCompletion('{"kind":"none"}');
    });
    const svc = {
      listMessages: vi.fn(async () => messages),
      complete,
    } as unknown as SupabaseService;
    const venice = {
      completeChat: vi.fn(),
      embed: vi.fn(),
    } as unknown as VeniceClient;

    await conversationRecall.execute(
      { topic: 'the Lisbon move' },
      ctxFor(svc, venice)
    );

    expect(seen).toHaveLength(1);
    const lastMsg = seen[0][seen[0].length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toMatch(/flagged this topic specifically: the Lisbon move/);
  });

  it('returns {kind:"none"} when the agent signals nothing worth injecting', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'small talk' }),
    ];
    const complete = vi.fn(async () => makeCompletion('{"kind":"none"}'));
    const svc = {
      listMessages: vi.fn(async () => messages),
      complete,
    } as unknown as SupabaseService;
    const venice = {
      completeChat: vi.fn(),
      embed: vi.fn(),
    } as unknown as VeniceClient;

    const result = await conversationRecall.execute({}, ctxFor(svc, venice));
    expect(result).toEqual({ kind: 'none' });
  });

  it('does not surface an agent error as a thrown tool error — collapses to {kind:"none"}', async () => {
    // An agent that can't recall shouldn't break the main chat. The
    // tool returns the safe fallback so the main model sees "nothing
    // to inject" and carries on rather than seeing a tool error
    // that might prompt a retry loop.
    const svc = {
      listMessages: vi.fn(async () => {
        throw new Error('supabase flaked');
      }),
      complete: vi.fn(),
    } as unknown as SupabaseService;
    const venice = {
      completeChat: vi.fn(),
      embed: vi.fn(),
    } as unknown as VeniceClient;

    const result = await conversationRecall.execute({}, ctxFor(svc, venice));
    expect(result).toEqual({ kind: 'none' });
  });
});
