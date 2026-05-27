/**
 * Gather + render + pipeline coverage for context-recall.
 *
 * Four surfaces:
 *
 *   1. `deriveRecallQuery` (pure) - builds the auto-injection search
 *      query from a thread's messages: last user turn plus the
 *      assistant response before it, ignoring any in-flight round at
 *      the tail.
 *   2. `renderContextThink` (pure) - turns the gathered index into the
 *      body of the synthetic <think> turn. Memory facts verbatim;
 *      conversations and wiki as title + id bullets naming the
 *      drill-down tool. All-empty renders to the empty string.
 *   3. `gatherContextIndex` - the deterministic three-layer search.
 *      Mocks the Supabase search methods (and a Venice client whose
 *      embed throws, so every layer takes its text-search fallback -
 *      the assembly logic under test is identical either way) and
 *      asserts caps, own-thread exclusion, and verbatim memory mapping.
 *   4. `runContextRecallPipeline` end-to-end - asserts the cached
 *      payload shape including the empty-note negative cache and the
 *      abort-returns-null posture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runContextRecallPipeline,
} from '../src/lib/context-recall/pipeline';
import {
  deriveRecallQuery,
  gatherContextIndex,
  renderContextThink,
  CONTEXT_CONVERSATION_LIMIT,
  CONTEXT_WIKI_LIMIT,
  type ContextIndex,
} from '../src/lib/context-recall/gather';
import { _clearContextRecallInflightForTests } from '../src/lib/context-recall/cache';
import type { VeniceClient } from '../src/lib/venice';
import type {
  SupabaseService,
  Message,
  Memory,
  WikiArticle,
  ThreadSearchHit,
  Thread,
} from '../src/lib/supabase';

// --- factories ------------------------------------------------------

function userTurn(content: string, n: number): Message {
  return {
    id: `u-${n}`,
    thread_id: 't-1',
    role: 'user',
    content,
    created_at: String(n),
  } as Message;
}

function assistantTurn(content: string, n: number): Message {
  return {
    id: `a-${n}`,
    thread_id: 't-1',
    role: 'assistant',
    content,
    created_at: String(n),
  } as Message;
}

function mem(id: string, data: string, confidence = 5, label = id): Memory {
  return {
    id,
    label,
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

/** Venice whose embed always throws - drives every search helper down
 *  its no-embedding text-search fallback so the test only has to mock
 *  the text-path Supabase methods. gatherContextIndex assembles the
 *  same way regardless of which search path the layers take. */
const veniceNoEmbed = {
  embed: vi.fn(async () => {
    throw new Error('offline');
  }),
} as unknown as VeniceClient;

function gatherSupabase(opts: {
  messages?: Message[];
  memories?: Memory[];
  threads?: ThreadSearchHit[];
  wiki?: WikiArticle[];
}): SupabaseService {
  return {
    listMessages: vi.fn(async () => opts.messages ?? []),
    // memory text-search fallback
    searchMemories: vi.fn(async () => opts.memories ?? []),
    searchMemoriesByEmbedding: vi.fn(async () => []),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
    // wiki text-search fallback + sole-source filter probe
    searchWikiArticles: vi.fn(async () => opts.wiki ?? []),
    listSourceThreadIdsForArticles: vi.fn(
      async () => new Map<string, Set<string>>()
    ),
    // conversation search
    searchThreads: vi.fn(async () => opts.threads ?? []),
  } as unknown as SupabaseService;
}

// --- deriveRecallQuery ---------------------------------------------

describe('deriveRecallQuery', () => {
  it('returns the empty string when there is no user turn', () => {
    expect(deriveRecallQuery([])).toBe('');
    expect(deriveRecallQuery([assistantTurn('hello there', 1)])).toBe('');
  });

  it('returns the last user message when there is no prior assistant turn', () => {
    expect(deriveRecallQuery([userTurn('how do I write a parser?', 1)])).toBe(
      'how do I write a parser?'
    );
  });

  it('prepends the assistant response immediately before the last user turn', () => {
    const messages = [
      userTurn('tell me about monads', 1),
      assistantTurn('a monad is a monoid in the category of endofunctors', 2),
      userTurn('what about the second law?', 3),
    ];
    expect(deriveRecallQuery(messages)).toBe(
      'a monad is a monoid in the category of endofunctors\n\nwhat about the second law?'
    );
  });

  it('anchors on the last USER turn, ignoring an in-flight assistant/tool tail', () => {
    // The pipeline fires mid-round: the chat-loop may have persisted an
    // assistant tool_calls row after the user's message. We anchor on
    // the last user turn, so that tail does not become the query.
    const messages = [
      assistantTurn('earlier answer', 1),
      userTurn('the real question', 2),
      assistantTurn('', 3), // in-flight tool_calls row (empty content)
    ];
    expect(deriveRecallQuery(messages)).toBe('earlier answer\n\nthe real question');
  });

  it('skips empty (tool-call-only) assistant rows when looking backward', () => {
    const messages = [
      assistantTurn('the substantive prior turn', 1),
      assistantTurn('', 2), // tool_calls-only row, no readable content
      userTurn('follow up', 3),
    ];
    expect(deriveRecallQuery(messages)).toBe(
      'the substantive prior turn\n\nfollow up'
    );
  });
});

// --- renderContextThink --------------------------------------------

describe('renderContextThink', () => {
  function index(partial: Partial<ContextIndex> = {}): ContextIndex {
    return {
      memories: partial.memories ?? [],
      conversations: partial.conversations ?? [],
      wiki: partial.wiki ?? [],
    };
  }

  it('renders the empty string when every layer is empty', () => {
    expect(renderContextThink(index())).toBe('');
  });

  it('inlines memory facts verbatim as bullets', () => {
    const out = renderContextThink(
      index({
        memories: [
          { id: 'm1', label: 'tabs', data: 'The user prefers tabs.', confidence_tag: 'corroborated' },
          { id: 'm2', label: 'tz', data: 'The user is in Lisbon.', confidence_tag: null },
        ],
      })
    );
    expect(out).toContain('I recall some related things about this topic:');
    expect(out).toContain('- The user prefers tabs.');
    expect(out).toContain('- The user is in Lisbon.');
  });

  it('annotates low-confidence memories so the model can hedge', () => {
    const out = renderContextThink(
      index({
        memories: [
          { id: 'm1', label: 'maybe', data: 'The user might own a boat.', confidence_tag: 'shaky' },
        ],
      })
    );
    expect(out).toContain('- The user might own a boat. (shaky recollection)');
  });

  it('lists conversations by title + id and names conversation_get', () => {
    const out = renderContextThink(
      index({
        conversations: [
          { id: 'c1', title: 'Parser pipeline design' },
          { id: 'c2', title: 'Lisbon move logistics' },
        ],
      })
    );
    expect(out).toContain('conversation_get');
    expect(out).toContain('- Parser pipeline design (id: c1)');
    expect(out).toContain('- Lisbon move logistics (id: c2)');
  });

  it('lists wiki articles by title + id and names wiki_get', () => {
    const out = renderContextThink(
      index({ wiki: [{ id: 'w1', title: 'The herb garden' }] })
    );
    expect(out).toContain('wiki_get');
    expect(out).toContain('- The herb garden (id: w1)');
  });

  it('joins present sections with a blank line and omits empty ones', () => {
    const out = renderContextThink(
      index({
        memories: [{ id: 'm1', label: 'x', data: 'A fact.', confidence_tag: null }],
        wiki: [{ id: 'w1', title: 'A topic' }],
      })
    );
    // Memory section then wiki section, no conversation section.
    expect(out).not.toContain('conversation_get');
    expect(out.indexOf('A fact.')).toBeLessThan(out.indexOf('A topic'));
    expect(out).toContain('\n\n');
  });
});

// --- gatherContextIndex --------------------------------------------

describe('gatherContextIndex', () => {
  const signal = new AbortController().signal;

  it('maps memories verbatim and references conversations + wiki by id', async () => {
    const supabase = gatherSupabase({
      memories: [mem('m1', 'The user grows basil.', 5)],
      threads: [threadHit('c1', 'Garden planning')],
      wiki: [wikiArt('w1', 'The herb garden')],
    });
    const out = await gatherContextIndex({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      signal,
      query: 'the garden',
    });
    expect(out.memories).toEqual([
      { id: 'm1', label: 'm1', data: 'The user grows basil.', confidence_tag: 'corroborated' },
    ]);
    expect(out.conversations).toEqual([{ id: 'c1', title: 'Garden planning' }]);
    expect(out.wiki).toEqual([{ id: 'w1', title: 'The herb garden' }]);
  });

  it('excludes the current thread from the conversation layer', async () => {
    const supabase = gatherSupabase({
      threads: [threadHit('t-1', 'this very thread'), threadHit('c2', 'another thread')],
    });
    const out = await gatherContextIndex({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      signal,
      query: 'something',
    });
    expect(out.conversations).toEqual([{ id: 'c2', title: 'another thread' }]);
  });

  it('caps conversations and wiki at their per-layer limits', async () => {
    const threads = Array.from({ length: CONTEXT_CONVERSATION_LIMIT + 3 }, (_, i) =>
      threadHit(`c${i}`, `thread ${i}`)
    );
    const wiki = Array.from({ length: CONTEXT_WIKI_LIMIT + 3 }, (_, i) =>
      wikiArt(`w${i}`, `article ${i}`)
    );
    const supabase = gatherSupabase({ threads, wiki });
    const out = await gatherContextIndex({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      signal,
      query: 'broad',
    });
    expect(out.conversations).toHaveLength(CONTEXT_CONVERSATION_LIMIT);
    expect(out.wiki).toHaveLength(CONTEXT_WIKI_LIMIT);
  });

  it('derives the query from the thread when no explicit topic is passed', async () => {
    const messages = [userTurn('how is the basil doing?', 1)];
    const supabase = gatherSupabase({
      messages,
      memories: [mem('m1', 'The user grows basil.', 5)],
    });
    const out = await gatherContextIndex({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      signal,
    });
    expect(supabase.listMessages).toHaveBeenCalledWith('t-1');
    expect(supabase.searchMemories).toHaveBeenCalledWith(
      'how is the basil doing?',
      expect.any(Number),
      expect.anything()
    );
    expect(out.memories).toHaveLength(1);
  });

  it('returns an all-empty index when there is nothing to search on', async () => {
    // No explicit topic and a thread with no user turn -> empty query
    // -> no searches run.
    const supabase = gatherSupabase({ messages: [assistantTurn('hi', 1)] });
    const out = await gatherContextIndex({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      signal,
    });
    expect(out).toEqual({ memories: [], conversations: [], wiki: [] });
    expect(supabase.searchMemories).not.toHaveBeenCalled();
    expect(supabase.searchThreads).not.toHaveBeenCalled();
  });

  it('returns an all-empty index when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const supabase = gatherSupabase({ memories: [mem('m1', 'x')] });
    const out = await gatherContextIndex({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      signal: ctl.signal,
      query: 'x',
    });
    expect(out).toEqual({ memories: [], conversations: [], wiki: [] });
    expect(supabase.searchMemories).not.toHaveBeenCalled();
  });

  it('degrades a throwing layer to empty instead of rejecting the gather', async () => {
    // The conversation layer throws (e.g. PostgREST rejecting an
    // oversized ILIKE query); the other two layers still contribute.
    // This isolation is load-bearing: the gather runs on the live
    // turn's critical path, so one layer's failure must not crash the
    // chat turn.
    const supabase = {
      ...gatherSupabase({
        memories: [mem('m1', 'The user grows basil.', 5)],
        wiki: [wikiArt('w1', 'The herb garden')],
      }),
      searchThreads: vi.fn(async () => {
        throw new Error('PostgREST 414 URI Too Long');
      }),
    } as unknown as SupabaseService;
    const out = await gatherContextIndex({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      signal,
      query: 'the garden',
    });
    expect(out.memories).toHaveLength(1);
    expect(out.conversations).toEqual([]);
    expect(out.wiki).toHaveLength(1);
  });
});

// --- runContextRecallPipeline --------------------------------------

describe('runContextRecallPipeline', () => {
  beforeEach(() => {
    _clearContextRecallInflightForTests();
  });

  it('returns a payload whose note renders the gathered index', async () => {
    const supabase = gatherSupabase({
      messages: [userTurn('how is the parser project?', 1)],
      memories: [mem('m1', 'The user is past the basics on Haskell.', 5)],
      threads: [threadHit('c1', 'Parser pipeline design')],
      wiki: [wikiArt('w1', 'Haskell parser project')],
    });
    const out = await runContextRecallPipeline({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      userId: 'u-1',
      signal: new AbortController().signal,
      round: 1,
      mood: { band: 2, column: 'confident' },
      trigger: 'cold',
    });
    expect(out).not.toBeNull();
    expect(out!.v).toBe(1);
    expect(out!.note).toContain('The user is past the basics on Haskell.');
    expect(out!.note).toContain('Parser pipeline design (id: c1)');
    expect(out!.note).toContain('Haskell parser project (id: w1)');
    expect(out!.computed_at_round).toBe(1);
    expect(out!.computed_at_band).toBe(2);
    expect(out!.computed_at_column).toBe('confident');
    expect(out!.trigger).toBe('cold');
  });

  it('caches the negative result with an empty note when every layer is empty', async () => {
    // The whole point of writing the negative cache: the trigger
    // evaluator's same-round debounce only works if computed_at_round
    // moves forward. An empty `note` is a legitimate cached state.
    const supabase = gatherSupabase({
      messages: [userTurn('hi', 1)],
    });
    const out = await runContextRecallPipeline({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      userId: 'u-1',
      signal: new AbortController().signal,
      round: 2,
      mood: null,
      trigger: 'mood',
    });
    expect(out).not.toBeNull();
    expect(out!.note).toBe('');
    expect(out!.computed_at_round).toBe(2);
    expect(out!.trigger).toBe('mood');
  });

  it('returns null when the signal is aborted before the run starts', async () => {
    const supabase = gatherSupabase({ messages: [userTurn('hi', 1)] });
    const ctl = new AbortController();
    ctl.abort();
    const out = await runContextRecallPipeline({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      userId: 'u-1',
      signal: ctl.signal,
      round: 1,
      mood: null,
      trigger: 'cold',
    });
    expect(out).toBeNull();
  });

  it('returns null instead of throwing when the gather blows up', async () => {
    // A throw from the non-layer part of the gather (here listMessages,
    // which builds the derived query) must not propagate: this pipeline
    // is awaited on the live chat turn, so a throw would crash the turn
    // with a generic error card rather than degrading priming. The
    // cold-start trigger on a brand-new thread is exactly the path that
    // motivated this guard.
    const supabase = {
      ...gatherSupabase({}),
      listMessages: vi.fn(async () => {
        throw new Error('read failed');
      }),
    } as unknown as SupabaseService;
    const out = await runContextRecallPipeline({
      venice: veniceNoEmbed,
      supabase,
      threadId: 't-1',
      userId: 'u-1',
      signal: new AbortController().signal,
      round: 1,
      mood: null,
      trigger: 'cold',
    });
    expect(out).toBeNull();
  });
});
