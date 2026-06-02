/**
 * Unit coverage for the `wiki_recall` tool. Light test layer mirroring
 * `memory-recall-tool.test.ts` and `conversation-recall-tool.test.ts`;
 * the heavy lifting for the agent itself lives wherever the recall
 * agent tests do.
 *
 *   - present in the main chat TOOLS list (model can see it);
 *   - absent from every agent-only toolbox (recall agents must not
 *     recurse, reflection / wiki / wiki-librarian have no reason to
 *     pull in another recall layer);
 *   - description points at the right surface (wiki_search) for
 *     direct lookups;
 *   - execute() routes through WikiRecallAgent and hands the parsed
 *     note back as the tool result.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  memoryToolbox,
  recallToolbox,
  conversationRecallToolbox,
  wikiRecallToolbox,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import { wikiRecall } from '../src/lib/tools/wiki_recall';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type { ChatCompletion, VeniceClient } from '../src/lib/venice';

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

describe('wiki_recall - registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('wiki_recall');
  });

  it('is absent from every agent-only toolbox - recall agents must not recurse', () => {
    // The recall agents (memory, conversation, wiki) each get a
    // read-only toolbox carrying ONLY the matching *_search tool.
    // Calling wiki_recall from any of those would be recursion for no
    // purpose; the toolboxes exclude it at the registry level rather
    // than relying on prompt discipline.
    for (const tb of [
      memoryToolbox,
      recallToolbox,
      conversationRecallToolbox,
      wikiRecallToolbox,
    ]) {
      expect(tb.tools.map((t) => t.name)).not.toContain('wiki_recall');
    }
  });

  it('description points at wiki_search for direct lookups', () => {
    expect(wikiRecall.description).toMatch(/recall/i);
    expect(wikiRecall.description).toMatch(/wiki_search/);
  });

  it('accepts an optional topic argument and nothing else', () => {
    expect(wikiRecall.parameters).toEqual({
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

describe('wiki_recall - execute() routes through WikiRecallAgent', () => {
  it('returns the parsed RecallNote as the tool result on the happy path', async () => {
    // The agent's chat-completion seam moved to supabase.complete in
    // milestone 6; the ctx.venice handle is still threaded through
    // because the agent constructor takes it, but the loop no longer
    // drives it. Script the completion on the supabase fixture.
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'how is the garden?' }),
    ];
    const listMessages = vi.fn(async () => messages);
    const complete = vi.fn(async () =>
      makeCompletion(
        '{"kind":"note","note":"the gardening article lists basil, thyme, and a perennial bed plan."}'
      )
    );
    const svc = { listMessages, complete } as unknown as SupabaseService;
    const venice = {
      completeChat: vi.fn(),
      embed: vi.fn(),
    } as unknown as VeniceClient;

    const result = await wikiRecall.execute({}, ctxFor(svc, venice));

    expect(result).toEqual({
      kind: 'note',
      note: 'the gardening article lists basil, thyme, and a perennial bed plan.',
    });
    expect(listMessages).toHaveBeenCalledWith('t-1');
  });

  it('returns {kind:"none"} when the agent signals nothing worth injecting', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'what time is it' }),
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

    const result = await wikiRecall.execute({}, ctxFor(svc, venice));
    expect(result).toEqual({ kind: 'none' });
  });

  it('does not surface an agent error as a thrown tool error - collapses to {kind:"none"}', async () => {
    // An agent that can't recall should not break the main chat. The
    // tool returns the safe fallback so the main model sees "nothing
    // to inject" and carries on rather than seeing a tool error that
    // might prompt a retry loop.
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

    const result = await wikiRecall.execute({}, ctxFor(svc, venice));
    expect(result).toEqual({ kind: 'none' });
  });
});
