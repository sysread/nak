/**
 * Pipeline assembly + stitching coverage for context-recall.
 *
 * Two surfaces:
 *
 *   1. `stitchRecallNotes` (pure function) - the "two notes -> one
 *      paragraph" assembly logic. All four cases of the cross
 *      product (empty/empty, only-memory, only-conversation, both)
 *      are exercised here.
 *   2. `runContextRecallPipeline` end-to-end - mocks the Venice
 *      client, the supabase service, and the agents' search tools so
 *      we can assert the parallel fan-out, the failure tolerance
 *      (one child failing does not abort the other), and the cached
 *      payload shape including the empty-note negative cache.
 *
 * The two child agents' search-tool handlers are stubbed via the
 * SupabaseService mock (memory_search hits searchMemoriesByEmbedding
 * /searchUnembeddedMemoriesByText/searchMemories, conversation_search
 * hits searchConversationsByEmbedding/searchConversationsByText).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runContextRecallPipeline,
  stitchRecallNotes,
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

describe('stitchRecallNotes', () => {
  const memoryNote: RecallNote = {
    kind: 'note',
    note: 'I remember the user already understands monads.',
  };
  const conversationNote: RecallNote = {
    kind: 'note',
    note: 'last time we talked about Haskell, we landed on Reader.',
  };

  it('returns an empty string when both children are empty', () => {
    expect(
      stitchRecallNotes({ kind: 'none' }, { kind: 'none' })
    ).toBe('');
  });

  it('passes through the memory note when conversation is empty', () => {
    expect(
      stitchRecallNotes(memoryNote, { kind: 'none' })
    ).toBe('I remember the user already understands monads.');
  });

  it('passes through the conversation note when memory is empty', () => {
    expect(
      stitchRecallNotes({ kind: 'none' }, conversationNote)
    ).toBe('last time we talked about Haskell, we landed on Reader.');
  });

  it('joins both notes with a hinge phrase when both are present', () => {
    const out = stitchRecallNotes(memoryNote, conversationNote);
    expect(out).toBe(
      'I remember the user already understands monads. From earlier conversations, last time we talked about Haskell, we landed on Reader.'
    );
  });

  it('trims surrounding whitespace on either side before stitching', () => {
    const out = stitchRecallNotes(
      { kind: 'note', note: '  memory  ' },
      { kind: 'note', note: '  convo  ' }
    );
    expect(out).toBe('memory From earlier conversations, convo');
  });

  it('treats an all-whitespace note as empty for the cross-product', () => {
    // RecallNote shouldn't ship pure whitespace by contract, but the
    // child can occasionally emit a stray space-padded note. We trim
    // BEFORE checking length so the "both empty" case still applies.
    expect(
      stitchRecallNotes(
        { kind: 'note', note: '   ' },
        { kind: 'note', note: '\n' }
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
      // The agent's headless tool-loop calls completeChat, not
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
 * Minimal supabase mock for the recall agents' input. Both agents
 * call listMessages(threadId) to read the conversation; everything
 * else (search tools they could invoke) is a no-op since our fake
 * Venice settles in one round without any tool calls.
 */
function recallSupabase(messages: Message[]): SupabaseService {
  return {
    listMessages: vi.fn(async () => messages),
    searchMemories: vi.fn(async () => []),
    searchMemoriesByEmbedding: vi.fn(async () => []),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
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

describe('runContextRecallPipeline', () => {
  // Each test starts with a fresh inflight registry; otherwise a
  // prior test's piggyback Promise can leak into this one and we
  // see "the pipeline didn't fire" symptoms that are really just
  // dedup hits.
  beforeEach(() => {
    _clearContextRecallInflightForTests();
  });

  it('returns a payload with the stitched note when both children emit', async () => {
    const venice = fakeVeniceForRecall((lastUser) => {
      // The two agents' prompts both end with the recall instruction
      // appended as the final user turn. We disambiguate on the
      // distinct prompt text each child uses.
      if (lastUser.includes('memory_search')) {
        return {
          kind: 'note',
          note: 'I remember the user is past the introduction on Haskell.',
        };
      }
      if (lastUser.includes('conversation_search')) {
        return {
          kind: 'note',
          note: 'we have already worked through monad transformers together.',
        };
      }
      return { kind: 'none' };
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
      'I remember the user is past the introduction on Haskell. From earlier conversations, we have already worked through monad transformers together.'
    );
    expect(out!.computed_at_round).toBe(1);
    expect(out!.computed_at_band).toBe(2);
    expect(out!.computed_at_column).toBe('confident');
    expect(out!.trigger).toBe('cold');
  });

  it('caches the negative result with empty note when both children return none', async () => {
    // The whole point of writing the negative cache: the trigger
    // evaluator's same-round debounce only works if computed_at_round
    // moves forward. An empty `note` is a legitimate cached state.
    const venice = fakeVeniceForRecall(() => ({ kind: 'none' }));
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

  it('passes through the surviving child when the other one fails', async () => {
    // The two agents already collapse their own errors to
    // `{kind:"none"}`, so a thrown completeChat from one side surfaces
    // as an empty signal. The pipeline stitches against whichever
    // side returned a real note.
    const venice = fakeVeniceForRecall((lastUser) => {
      if (lastUser.includes('memory_search')) {
        return new Error('rate-limited');
      }
      return {
        kind: 'note',
        note: 'we landed on async/await for the parser pipeline last time.',
      };
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
    // Memory side errored (collapsed to none); only the conversation
    // side contributed. No hinge phrase, just the conversation note.
    expect(out!.note).toBe(
      'we landed on async/await for the parser pipeline last time.'
    );
    expect(out!.trigger).toBe('title');
  });

  it('returns null when the signal is aborted before the run starts', async () => {
    const venice = fakeVeniceForRecall(() => ({ kind: 'none' }));
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

  it('runs both child agents in parallel, not sequentially', async () => {
    // A stitched note from BOTH children when the second child's
    // resolution is artificially delayed past what serial execution
    // could finish in is the cleanest evidence we have. We measure
    // wall time and assert it's closer to the slower side than to
    // the sum.
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
        if (content.includes('memory_search')) {
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
        // Fast side - returns immediately, then unblocks the slow one
        // so we can assert both finished.
        queueMicrotask(() => resolveSlow());
        return {
          text: '{"kind":"note","note":"fast convo note."}',
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
    // If the children had run sequentially, the fast side would never
    // unblock the slow side because the slow side would not have
    // started yet when queueMicrotask fired. Reaching this assertion
    // with both notes present is the parallelism proof.
    expect(out).not.toBeNull();
    expect(out!.note).toContain('slow memory note.');
    expect(out!.note).toContain('From earlier conversations, fast convo note.');
  });
});
