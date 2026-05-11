/**
 * Pipeline assembly + stitching coverage for context-recall.
 *
 * Two surfaces:
 *
 *   1. `stitchRecallNotes` (pure function) - the "four notes -> one
 *      paragraph" assembly logic. The cross-product is too large to
 *      enumerate exhaustively (4 layers x 2 states each = 16 cases);
 *      we cover the all-empty case, every single-non-empty case, the
 *      memory-leads-two-layer case (memory anchor with one hinge),
 *      the memory-empty-conversation-leads case (verifies the anchor
 *      role moves to whichever layer is first non-empty), and the
 *      all-four-present case.
 *   2. `runContextRecallPipeline` end-to-end - mocks the Venice
 *      client, the supabase service, and the agents' search tools so
 *      we can assert the parallel fan-out, the failure tolerance
 *      (one child failing does not abort the others), and the cached
 *      payload shape including the empty-note negative cache.
 *
 * The child agents' search-tool handlers are stubbed via the
 * SupabaseService mock (memory_search hits searchMemoriesByEmbedding
 * /searchUnembeddedMemoriesByText/searchMemories, conversation_search
 * hits searchConversationsByEmbedding/searchConversationsByText,
 * etc.) but the fake Venice in this file settles in one round
 * without any tool calls, so the search-tool stubs only need to
 * exist as no-ops.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runContextRecallPipeline,
  runRecallFanOut,
  stitchRecallNotes,
  type RecallFanOutResult,
} from '../src/lib/context-recall/pipeline';
import { _clearContextRecallInflightForTests } from '../src/lib/context-recall/cache';
import type { RecallNote } from '../src/lib/agents/recall/agent';
import type {
  ChatRequest,
  ChatCompletion,
  StreamEvent,
  VeniceClient,
} from '../src/lib/venice';
import type { SupabaseService, Message } from '../src/lib/supabase';

const NONE: RecallNote = { kind: 'none' };

function note(text: string): RecallNote {
  return { kind: 'note', note: text };
}

function fanOut(
  partial: Partial<RecallFanOutResult> = {}
): RecallFanOutResult {
  return {
    memory: partial.memory ?? NONE,
    conversation: partial.conversation ?? NONE,
    wiki: partial.wiki ?? NONE,
    journal: partial.journal ?? NONE,
  };
}

describe('stitchRecallNotes', () => {
  it('returns an empty string when every layer is empty', () => {
    expect(stitchRecallNotes(fanOut())).toBe('');
  });

  it('passes through the memory note verbatim when it is the only non-empty', () => {
    expect(
      stitchRecallNotes(
        fanOut({ memory: note('I remember the user prefers tabs.') })
      )
    ).toBe('I remember the user prefers tabs.');
  });

  it('passes through the conversation note verbatim when it is the only non-empty', () => {
    expect(
      stitchRecallNotes(
        fanOut({
          conversation: note('last time we landed on Reader for the parser.'),
        })
      )
    ).toBe('last time we landed on Reader for the parser.');
  });

  it('passes through the wiki note verbatim when it is the only non-empty', () => {
    expect(
      stitchRecallNotes(
        fanOut({ wiki: note('the gardening article lists basil and thyme.') })
      )
    ).toBe('the gardening article lists basil and thyme.');
  });

  it('passes through the journal note verbatim when it is the only non-empty', () => {
    expect(
      stitchRecallNotes(
        fanOut({
          journal: note('the user worked through this in April; tentative mood.'),
        })
      )
    ).toBe('the user worked through this in April; tentative mood.');
  });

  it('joins memory + conversation with the conversation hinge', () => {
    expect(
      stitchRecallNotes(
        fanOut({
          memory: note('I remember the user already understands monads.'),
          conversation: note(
            'last time we talked about Haskell, we landed on Reader.'
          ),
        })
      )
    ).toBe(
      'I remember the user already understands monads. From earlier conversations, last time we talked about Haskell, we landed on Reader.'
    );
  });

  it('uses conversation as the anchor (no hinge) when memory is empty', () => {
    expect(
      stitchRecallNotes(
        fanOut({
          conversation: note('we landed on async/await for the parser.'),
          wiki: note('the parser article calls out the streaming variant.'),
        })
      )
    ).toBe(
      'we landed on async/await for the parser. From the wiki, the parser article calls out the streaming variant.'
    );
  });

  it('stitches all four layers in fixed order with their hinges', () => {
    expect(
      stitchRecallNotes(
        fanOut({
          memory: note('I remember the user is past the introduction here.'),
          conversation: note('we worked through this in March.'),
          wiki: note('the article tracks the long arc on this topic.'),
          journal: note('the entries from that week carried hesitant mood.'),
        })
      )
    ).toBe(
      'I remember the user is past the introduction here. From earlier conversations, we worked through this in March. From the wiki, the article tracks the long arc on this topic. From the journal, the entries from that week carried hesitant mood.'
    );
  });

  it('trims surrounding whitespace on every layer before stitching', () => {
    expect(
      stitchRecallNotes(
        fanOut({
          memory: note('  memory  '),
          conversation: note('  convo  '),
        })
      )
    ).toBe('memory From earlier conversations, convo');
  });

  it('treats whitespace-only notes as empty for the cross-product', () => {
    expect(
      stitchRecallNotes(
        fanOut({
          memory: note('   '),
          conversation: note('\n'),
          wiki: note(' \t '),
          journal: note(''),
        })
      )
    ).toBe('');
  });
});

/**
 * Lightweight Venice mock that responds to whatever messages.length
 * arrives - we don't care about prompt content here, only that the
 * pipeline reaches the model and the model emits the JSON shape the
 * agents expect.
 */
function fakeVeniceForRecall(
  responseFor: (lastUserContent: string) => RecallNote | Error
): VeniceClient {
  return {
    async *streamChat(_req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
      // The agents' headless tool-loop calls completeChat, not
      // streamChat. Yield nothing; existence of the method satisfies
      // the type.
      yield { type: 'text', delta: '' };
    },
    completeChat: async (req: ChatRequest): Promise<ChatCompletion> => {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
      const result = responseFor(content);
      if (result instanceof Error) throw result;
      const text =
        result.kind === 'none'
          ? '{"kind":"none"}'
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

/**
 * Minimal supabase mock for the recall agents' input. Every agent
 * calls listMessages(threadId) to read the conversation; the search
 * stubs need to exist (the four agents share a SupabaseService
 * shape) but the fake Venice settles in one round without any tool
 * calls, so the stubs only need to return empty arrays.
 */
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

function userTurn(content: string, n: number): Message {
  return {
    id: `m-${n}`,
    thread_id: 't-1',
    role: 'user',
    content,
    created_at: String(n),
  };
}

/**
 * The four recall prompts each contain a distinctive phrase
 * referencing their target search tool (`memory_search`,
 * `conversation_search`, `wiki_search`, `journal_search`). The fake
 * Venice in these tests routes responses by sniffing those phrases
 * out of the last user turn (which is the prompt itself). Keep this
 * list in sync if the prompts ever change.
 */
function classifyLayer(
  lastUser: string
): 'memory' | 'conversation' | 'wiki' | 'journal' | 'unknown' {
  if (lastUser.includes('memory_search')) return 'memory';
  if (lastUser.includes('conversation_search')) return 'conversation';
  if (lastUser.includes('wiki_search')) return 'wiki';
  if (lastUser.includes('journal_search')) return 'journal';
  return 'unknown';
}

describe('runContextRecallPipeline', () => {
  // Each test starts with a fresh inflight registry; otherwise a
  // prior test's piggyback Promise can leak into this one and we
  // see "the pipeline didn't fire" symptoms that are really just
  // dedup hits.
  beforeEach(() => {
    _clearContextRecallInflightForTests();
  });

  it('returns a payload with the stitched note when every layer emits', async () => {
    const venice = fakeVeniceForRecall((lastUser) => {
      const layer = classifyLayer(lastUser);
      if (layer === 'memory') {
        return note('I remember the user is past the introduction on Haskell.');
      }
      if (layer === 'conversation') {
        return note('we have already worked through monad transformers together.');
      }
      if (layer === 'wiki') {
        return note('the Haskell article notes a parser project in progress.');
      }
      if (layer === 'journal') {
        return note('entries from that week carried curious mood.');
      }
      return NONE;
    });
    const supabase = recallSupabase([userTurn('how do I write a parser?', 1)]);
    const out = await runContextRecallPipeline({
      venice,
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
    expect(out!.note).toBe(
      'I remember the user is past the introduction on Haskell. From earlier conversations, we have already worked through monad transformers together. From the wiki, the Haskell article notes a parser project in progress. From the journal, entries from that week carried curious mood.'
    );
    expect(out!.computed_at_round).toBe(1);
    expect(out!.computed_at_band).toBe(2);
    expect(out!.computed_at_column).toBe('confident');
    expect(out!.trigger).toBe('cold');
  });

  it('caches the negative result with empty note when every layer returns none', async () => {
    // The whole point of writing the negative cache: the trigger
    // evaluator's same-round debounce only works if
    // computed_at_round moves forward. An empty `note` is a
    // legitimate cached state.
    const venice = fakeVeniceForRecall(() => NONE);
    const supabase = recallSupabase([userTurn('hi', 1)]);
    const out = await runContextRecallPipeline({
      venice,
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

  it('passes through the surviving layers when one of the children fails', async () => {
    // Each agent already collapses its own errors to `{kind:'none'}`
    // so a thrown completeChat from one side surfaces as an empty
    // signal. The pipeline stitches against whichever sides returned
    // real notes.
    const venice = fakeVeniceForRecall((lastUser) => {
      const layer = classifyLayer(lastUser);
      if (layer === 'memory') return new Error('rate-limited');
      if (layer === 'conversation') {
        return note('we landed on async/await for the parser pipeline last time.');
      }
      return NONE;
    });
    const supabase = recallSupabase([userTurn('parser pipeline?', 1)]);
    const out = await runContextRecallPipeline({
      venice,
      supabase,
      threadId: 't-1',
      userId: 'u-1',
      signal: new AbortController().signal,
      round: 3,
      mood: { band: 1, column: 'tentative' },
      trigger: 'title',
    });
    expect(out).not.toBeNull();
    // Memory errored (collapsed to none); only the conversation
    // layer contributed. As the first non-empty in layer order it
    // becomes the anchor and goes verbatim - no hinge.
    expect(out!.note).toBe(
      'we landed on async/await for the parser pipeline last time.'
    );
    expect(out!.trigger).toBe('title');
  });

  it('returns null when the signal is aborted before the run starts', async () => {
    const venice = fakeVeniceForRecall(() => NONE);
    const supabase = recallSupabase([userTurn('hi', 1)]);
    const ctl = new AbortController();
    ctl.abort();
    const out = await runContextRecallPipeline({
      venice,
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

  it('runs all four child agents in parallel, not sequentially', async () => {
    // The cleanest parallelism evidence: a stitched note from a
    // child whose resolution is gated on a microtask kicked by a
    // sibling. Serial execution would deadlock because the gate is
    // never released; parallel execution settles cleanly with both
    // notes present.
    let resolveSlow!: () => void;
    const slow = new Promise<void>((r) => {
      resolveSlow = r;
    });
    const venice: VeniceClient = {
      async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'text', delta: '' };
      },
      completeChat: async (req: ChatRequest): Promise<ChatCompletion> => {
        const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
        const content =
          typeof lastUser?.content === 'string' ? lastUser.content : '';
        const layer = classifyLayer(content);
        if (layer === 'memory') {
          // Slow side - waits on the gate.
          await slow;
          return {
            text: '{"kind":"note","note":"slow memory note."}',
            reasoning: '',
            toolCalls: [],
            usage: null,
            citations: [],
            finishReason: 'stop',
          };
        }
        if (layer === 'conversation') {
          // Fast side - returns immediately, then unblocks the slow
          // memory side so we can assert both finished.
          queueMicrotask(() => resolveSlow());
          return {
            text: '{"kind":"note","note":"fast convo note."}',
            reasoning: '',
            toolCalls: [],
            usage: null,
            citations: [],
            finishReason: 'stop',
          };
        }
        // Wiki and journal return empty; we don't need them to gate
        // anything for this parallelism check.
        return {
          text: '{"kind":"none"}',
          reasoning: '',
          toolCalls: [],
          usage: null,
          citations: [],
          finishReason: 'stop',
        };
      },
    } as unknown as VeniceClient;
    const supabase = recallSupabase([userTurn('hi', 1)]);
    const out = await runContextRecallPipeline({
      venice,
      supabase,
      threadId: 't-1',
      userId: 'u-1',
      signal: new AbortController().signal,
      round: 1,
      mood: null,
      trigger: 'cold',
    });
    // If the children had run sequentially, the fast side would
    // never unblock the slow side because the slow side would not
    // have started yet when queueMicrotask fired. Reaching this
    // assertion with both notes present is the parallelism proof.
    expect(out).not.toBeNull();
    expect(out!.note).toContain('slow memory note.');
    expect(out!.note).toContain('From earlier conversations, fast convo note.');
  });
});

describe('runRecallFanOut', () => {
  beforeEach(() => {
    _clearContextRecallInflightForTests();
  });

  it('forwards an optional topic hint to the per-layer agents that accept one', async () => {
    // Memory recall has no topic field by contract (its prompt is
    // keyed on the conversation itself). Conversation, wiki, and
    // journal accept one as an optional input. We verify the hint
    // arrives by sniffing the last user-turn content the fake
    // Venice sees: the per-layer prompts append "The main assistant
    // flagged this topic specifically: <topic>" when one is passed.
    const seenTopicForLayer: Record<string, boolean> = {
      memory: false,
      conversation: false,
      wiki: false,
      journal: false,
    };
    const venice = fakeVeniceForRecall((lastUser) => {
      const layer = classifyLayer(lastUser);
      if (layer !== 'unknown') {
        seenTopicForLayer[layer] =
          lastUser.includes('flagged this topic specifically: the herb garden');
      }
      return NONE;
    });
    const supabase = recallSupabase([userTurn('how is the garden?', 1)]);
    await runRecallFanOut({
      venice,
      supabase,
      threadId: 't-1',
      userId: 'u-1',
      signal: new AbortController().signal,
      topic: 'the herb garden',
    });
    // Memory prompt does NOT carry the hint - it's the no-topic
    // recall agent.
    expect(seenTopicForLayer.memory).toBe(false);
    // The other three DO.
    expect(seenTopicForLayer.conversation).toBe(true);
    expect(seenTopicForLayer.wiki).toBe(true);
    expect(seenTopicForLayer.journal).toBe(true);
  });
});
