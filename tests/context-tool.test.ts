/**
 * Unit coverage for the umbrella `context` tool. Tests its registry
 * presence, that it is excluded from every agent-only toolbox, and
 * that execute() fans out across the four recall agents and returns
 * a stitched note (or the synthesised empty signal when every layer
 * is silent).
 *
 * The heavy fan-out + stitch logic is tested in
 * `context-recall-pipeline.test.ts`; this file checks the tool
 * surface itself: how it wraps `runRecallFanOut` and `stitchRecallNotes`
 * and how it shapes the tool result.
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
import { contextTool } from '../src/lib/tools/context';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type {
  ChatCompletion,
  ChatRequest,
  StreamEvent,
  VeniceClient,
} from '../src/lib/venice';
import type { RecallNote } from '../src/lib/agents/recall/agent';

function ctxFor(svc: SupabaseService, venice: VeniceClient): ToolContext {
  return {
    supabase: svc,
    venice,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

function fakeVeniceForRecall(
  responseFor: (lastUser: string) => RecallNote
): VeniceClient {
  return {
    async *streamChat(_req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'text', delta: '' };
    },
    completeChat: async (req: ChatRequest): Promise<ChatCompletion> => {
      const lastUser = [...req.messages]
        .reverse()
        .find((m) => m.role === 'user');
      const content =
        typeof lastUser?.content === 'string' ? lastUser.content : '';
      const result = responseFor(content);
      const text =
        result.kind === 'none'
          ? `{"kind":"none","reason":${JSON.stringify(result.reason ?? 'none')}}`
          : `{"kind":"note","note":${JSON.stringify(result.note)}}`;
      return {
        text,
        reasoning: '',
        toolCalls: [],
        usage: null,
        citations: [],
        finishReason: 'stop',
      };
    },
  } as unknown as VeniceClient;
}

function recallSupabase(messages: Message[]): SupabaseService {
  return {
    listMessages: vi.fn(async () => messages),
    searchMemories: vi.fn(async () => []),
    searchMemoriesByEmbedding: vi.fn(async () => []),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
    searchConversationsByEmbedding: vi.fn(async () => []),
    searchConversationsByText: vi.fn(async () => []),
    searchWikiArticlesByEmbedding: vi.fn(async () => []),
    searchWikiArticlesByText: vi.fn(async () => []),
    searchJournalEntriesByEmbedding: vi.fn(async () => []),
    searchJournalEntriesByText: vi.fn(async () => []),
  } as unknown as SupabaseService;
}

describe('context - registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('context');
  });

  it('is absent from every agent-only toolbox - umbrella recall must not recurse', () => {
    for (const tb of [
      memoryToolbox,
      recallToolbox,
      conversationRecallToolbox,
      wikiRecallToolbox,
      journalRecallToolbox,
    ]) {
      expect(tb.tools.map((t) => t.name)).not.toContain('context');
    }
  });

  it('description frames itself as the preferred first step for broad lookups', () => {
    // The system prompt nudges the model to "consider calling context
    // first." For that to actually move behaviour, the tool description
    // also has to carry the framing - the model reads the description
    // when deciding whether to fire the tool, not just the system
    // prompt.
    expect(contextTool.description.toLowerCase()).toContain('preferred first');
    // And mentions every layer it spans, so the model knows what it
    // gets in exchange for the round-trip.
    expect(contextTool.description.toLowerCase()).toContain('memor');
    expect(contextTool.description.toLowerCase()).toContain('conversation');
    expect(contextTool.description.toLowerCase()).toContain('wiki');
    expect(contextTool.description.toLowerCase()).toContain('journal');
  });

  it('accepts an optional topic argument and nothing else', () => {
    expect(contextTool.parameters).toEqual({
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

describe('context - execute() fans out across the four recall agents', () => {
  it('returns a stitched note when at least one layer carries signal', async () => {
    const messages: Message[] = [
      {
        id: 'u1',
        thread_id: 't-1',
        role: 'user',
        content: 'how is the garden going?',
        created_at: '2024-01-01T00:00:00Z',
      } as Message,
    ];
    const venice = fakeVeniceForRecall((lastUser) => {
      // Two layers carry signal; the other two return the empty
      // signal so we can verify the stitch composes them correctly.
      if (lastUser.includes('memory_search')) {
        return { kind: 'note', note: 'I remember the user grows basil.' };
      }
      if (lastUser.includes('wiki_search')) {
        return {
          kind: 'note',
          note: 'the gardening article lists a perennial bed plan.',
        };
      }
      return { kind: 'none', reason: 'nothing here' };
    });
    const svc = recallSupabase(messages);

    const result = await contextTool.execute({}, ctxFor(svc, venice));

    expect(result).toEqual({
      kind: 'note',
      note:
        'I remember the user grows basil. From the wiki, the gardening article lists a perennial bed plan.',
    });
  });

  it('returns {kind:"none"} with concatenated per-layer reasons when every layer is silent', async () => {
    const messages: Message[] = [
      {
        id: 'u1',
        thread_id: 't-1',
        role: 'user',
        content: 'hi',
        created_at: '2024-01-01T00:00:00Z',
      } as Message,
    ];
    const venice = fakeVeniceForRecall((lastUser) => {
      if (lastUser.includes('memory_search')) {
        return { kind: 'none', reason: 'no memories matched' };
      }
      if (lastUser.includes('conversation_search')) {
        return { kind: 'none', reason: 'no prior threads' };
      }
      if (lastUser.includes('wiki_search')) {
        return { kind: 'none', reason: 'no relevant articles' };
      }
      if (lastUser.includes('journal_search')) {
        return { kind: 'none', reason: 'operational topic, no signal' };
      }
      return { kind: 'none', reason: 'unknown' };
    });
    const svc = recallSupabase(messages);

    const result = (await contextTool.execute(
      {},
      ctxFor(svc, venice)
    )) as RecallNote;

    expect(result.kind).toBe('none');
    // The synthesised reason concatenates each per-layer reason so a
    // diagnostic loop can see which surfaces are silent and why.
    if (result.kind === 'none') {
      expect(result.reason).toContain('memory: no memories matched');
      expect(result.reason).toContain('conversation: no prior threads');
      expect(result.reason).toContain('wiki: no relevant articles');
      expect(result.reason).toContain('journal: operational topic, no signal');
    }
  });

  it('forwards the topic hint to the layers that accept one', async () => {
    // Memory has no topic field by contract; the other three append
    // "The main assistant flagged this topic specifically: <topic>"
    // to the prompt when one is passed.
    const seenTopicForLayer: Record<string, boolean> = {
      memory: false,
      conversation: false,
      wiki: false,
      journal: false,
    };
    const venice = fakeVeniceForRecall((lastUser) => {
      let layer: 'memory' | 'conversation' | 'wiki' | 'journal' | 'unknown' =
        'unknown';
      if (lastUser.includes('memory_search')) layer = 'memory';
      else if (lastUser.includes('conversation_search')) layer = 'conversation';
      else if (lastUser.includes('wiki_search')) layer = 'wiki';
      else if (lastUser.includes('journal_search')) layer = 'journal';
      if (layer !== 'unknown') {
        seenTopicForLayer[layer] =
          lastUser.includes('flagged this topic specifically: my dad');
      }
      return { kind: 'none', reason: 'check only' };
    });
    const svc = recallSupabase([
      {
        id: 'u1',
        thread_id: 't-1',
        role: 'user',
        content: 'I have been thinking about my dad again',
        created_at: '2024-01-01T00:00:00Z',
      } as Message,
    ]);

    await contextTool.execute({ topic: 'my dad' }, ctxFor(svc, venice));

    expect(seenTopicForLayer.memory).toBe(false);
    expect(seenTopicForLayer.conversation).toBe(true);
    expect(seenTopicForLayer.wiki).toBe(true);
    expect(seenTopicForLayer.journal).toBe(true);
  });
});
