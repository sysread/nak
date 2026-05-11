/**
 * Unit coverage for the `journal_recall` tool. Light test layer
 * mirroring `memory-recall-tool.test.ts` and `wiki-recall-tool.test.ts`.
 *
 *   - present in the main chat TOOLS list (model can see it);
 *   - absent from every agent-only toolbox (recall agents must not
 *     recurse, reflection has no reason to pull in another recall
 *     layer);
 *   - description points at the right surface (journal_search /
 *     journal_read) for direct lookups;
 *   - execute() routes through JournalRecallAgent and hands the
 *     parsed note back as the tool result.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  memoryToolbox,
  recallToolbox,
  conversationRecallToolbox,
  wikiRecallToolbox,
  journalRecallToolbox,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import { journalRecall } from '../src/lib/tools/journal_recall';
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

describe('journal_recall - registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('journal_recall');
  });

  it('is absent from every agent-only toolbox - recall agents must not recurse', () => {
    for (const tb of [
      memoryToolbox,
      recallToolbox,
      conversationRecallToolbox,
      wikiRecallToolbox,
      journalRecallToolbox,
    ]) {
      expect(tb.tools.map((t) => t.name)).not.toContain('journal_recall');
    }
  });

  it('description points at journal_search / journal_read for direct lookups', () => {
    expect(journalRecall.description).toMatch(/recall/i);
    expect(journalRecall.description).toMatch(/journal_search|journal_read/);
  });

  it('accepts an optional topic argument and nothing else', () => {
    expect(journalRecall.parameters).toEqual({
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

describe('journal_recall - execute() routes through JournalRecallAgent', () => {
  it('returns the parsed RecallNote as the tool result on the happy path', async () => {
    const messages: Message[] = [
      makeMessage({
        id: 'u1',
        role: 'user',
        content: 'I have been thinking about my dad again',
      }),
    ];
    const listMessages = vi.fn(async () => messages);
    const svc = { listMessages } as unknown as SupabaseService;

    const completeChat = vi.fn(async () =>
      makeCompletion(
        '{"kind":"note","note":"the user worked through this in April; the entries from that week carried tentative-low mood."}'
      )
    );
    const venice = { completeChat, embed: vi.fn() } as unknown as VeniceClient;

    const result = await journalRecall.execute({}, ctxFor(svc, venice));

    expect(result).toEqual({
      kind: 'note',
      note: 'the user worked through this in April; the entries from that week carried tentative-low mood.',
    });
    expect(listMessages).toHaveBeenCalledWith('t-1');
  });

  it('returns {kind:"none"} when the agent signals nothing worth injecting', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'help me write a regex' }),
    ];
    const svc = {
      listMessages: vi.fn(async () => messages),
    } as unknown as SupabaseService;
    const completeChat = vi.fn(async () => makeCompletion('{"kind":"none"}'));
    const venice = { completeChat, embed: vi.fn() } as unknown as VeniceClient;

    const result = await journalRecall.execute({}, ctxFor(svc, venice));
    expect(result).toEqual({ kind: 'none' });
  });

  it('does not surface an agent error as a thrown tool error - collapses to {kind:"none"}', async () => {
    const svc = {
      listMessages: vi.fn(async () => {
        throw new Error('supabase flaked');
      }),
    } as unknown as SupabaseService;
    const venice = {
      completeChat: vi.fn(),
      embed: vi.fn(),
    } as unknown as VeniceClient;

    const result = await journalRecall.execute({}, ctxFor(svc, venice));
    expect(result).toEqual({ kind: 'none' });
  });
});
