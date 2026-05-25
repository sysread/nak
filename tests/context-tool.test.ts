/**
 * Unit coverage for the umbrella `context` tool. Tests its registry
 * presence, that it is excluded from every agent-only toolbox, and
 * that execute() runs the deterministic three-layer gather and returns
 * the structured index (memory facts verbatim; conversations + wiki as
 * a title/id index for drill-down).
 *
 * The gather + render assembly logic is tested in
 * `context-recall-pipeline.test.ts`; this file checks the tool surface
 * itself: how it wraps `gatherContextIndex` and shapes the result.
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
import { contextTool } from '../src/lib/tools/context';
import type {
  SupabaseService,
  Message,
  Memory,
  WikiArticle,
  ThreadSearchHit,
  Thread,
} from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';

// Venice whose embed throws, so every search helper takes its
// text-search fallback - the tool assembles the index identically
// regardless of search path.
const veniceNoEmbed = {
  embed: vi.fn(async () => {
    throw new Error('offline');
  }),
} as unknown as VeniceClient;

function ctxFor(svc: SupabaseService): ToolContext {
  return {
    supabase: svc,
    venice: veniceNoEmbed,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

function mem(id: string, data: string, confidence = 5): Memory {
  return {
    id,
    label: id,
    data,
    confidence,
    topics: [],
    created_at: '1',
    updated_at: '1',
  };
}

function threadHit(id: string, title: string): ThreadSearchHit {
  return {
    thread: { id, title } as unknown as Thread,
    kind: 'semantic',
    similarity: 0.9,
  };
}

function wikiArt(id: string, title: string): WikiArticle {
  return { id, title, content: 'body' } as unknown as WikiArticle;
}

function gatherSupabase(opts: {
  messages?: Message[];
  memories?: Memory[];
  threads?: ThreadSearchHit[];
  wiki?: WikiArticle[];
}): SupabaseService {
  return {
    listMessages: vi.fn(async () => opts.messages ?? []),
    searchMemories: vi.fn(async () => opts.memories ?? []),
    searchMemoriesByEmbedding: vi.fn(async () => []),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
    searchWikiArticles: vi.fn(async () => opts.wiki ?? []),
    listSourceThreadIdsForArticles: vi.fn(
      async () => new Map<string, Set<string>>()
    ),
    searchThreads: vi.fn(async () => opts.threads ?? []),
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
    ]) {
      expect(tb.tools.map((t) => t.name)).not.toContain('context');
    }
  });

  it('description frames itself as the preferred first step for broad lookups', () => {
    expect(contextTool.description.toLowerCase()).toContain('preferred first');
    // And mentions every layer it spans, so the model knows what it
    // gets in exchange for the round-trip.
    expect(contextTool.description.toLowerCase()).toContain('memor');
    expect(contextTool.description.toLowerCase()).toContain('conversation');
    expect(contextTool.description.toLowerCase()).toContain('wiki');
    // And names the drill-down tools the id index is meant to feed.
    expect(contextTool.description).toContain('conversation_get');
    expect(contextTool.description).toContain('wiki_get');
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

describe('context - execute() gathers the three-layer index', () => {
  it('returns memory facts verbatim and conversations + wiki by id', async () => {
    const svc = gatherSupabase({
      memories: [mem('m1', 'The user grows basil.', 5)],
      threads: [threadHit('c1', 'Garden planning')],
      wiki: [wikiArt('w1', 'The herb garden')],
    });

    const result = await contextTool.execute({ topic: 'the garden' }, ctxFor(svc));

    expect(result).toEqual({
      memories: [
        {
          id: 'm1',
          label: 'm1',
          data: 'The user grows basil.',
          confidence_tag: 'corroborated',
        },
      ],
      conversations: [{ id: 'c1', title: 'Garden planning' }],
      wiki: [{ id: 'w1', title: 'The herb garden' }],
    });
  });

  it('uses the explicit topic as the query without reading the thread', async () => {
    const svc = gatherSupabase({ memories: [mem('m1', 'A fact.')] });

    await contextTool.execute({ topic: 'my dad' }, ctxFor(svc));

    // Explicit topic -> no need to derive a query from the thread.
    expect(svc.listMessages).not.toHaveBeenCalled();
    expect(svc.searchMemories).toHaveBeenCalledWith(
      'my dad',
      expect.any(Number),
      expect.anything()
    );
  });

  it('derives the query from the thread when no topic is passed', async () => {
    const svc = gatherSupabase({
      messages: [
        {
          id: 'u1',
          thread_id: 't-1',
          role: 'user',
          content: 'tell me about the move',
          created_at: '1',
        } as Message,
      ],
    });

    await contextTool.execute({}, ctxFor(svc));

    expect(svc.listMessages).toHaveBeenCalledWith('t-1');
    expect(svc.searchMemories).toHaveBeenCalledWith(
      'tell me about the move',
      expect.any(Number),
      expect.anything()
    );
  });

  it('returns empty arrays when every layer is silent', async () => {
    const svc = gatherSupabase({ messages: [] });

    const result = await contextTool.execute({}, ctxFor(svc));

    expect(result).toEqual({ memories: [], conversations: [], wiki: [] });
  });
});
