/**
 * Chat-loop orchestration tests.
 *
 * The loop composes a lot of moving parts (streaming SSE, tool
 * dispatch, Supabase persistence), so we stub each collaborator to a
 * minimal fake and assert on the loop's observable behavior:
 *   - right messages persisted in the right order
 *   - concurrent tool execution (not serialized)
 *   - toggle_tools flipping state mid-loop
 *   - abort cascading through child tool signals
 *   - MAX_ROUNDS guardrail
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runChatLoop,
  MAX_ROUNDS,
  toVeniceMessage,
  INTERRUPTED_MARKER,
  buildThreadAttachmentsBlock,
  __test as chatLoopTest,
} from '../src/lib/chat-loop';
import type {
  ChatCompletion,
  ChatRequest,
  Citation,
  StreamEvent,
  TokenUsage,
} from '../src/lib/venice';
import type { VeniceClient } from '../src/lib/venice';
import type {
  SupabaseService,
  Thread,
  Message,
  ThreadAttachmentSummary,
} from '../src/lib/supabase';
import type { OpenAIToolCall } from '../src/lib/tools';

function mkThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't-1',
    user_id: 'u-1',
    title: 'Test',
    model: null,
    reasoning_effort: null,
    verbosity: null,
    toolboxes_enabled: [],
    archived: false,
    title_manually_set: false,
    intuition_payload: null,
    context_recall_payload: null,
    created_at: 'now',
    updated_at: 'now',
    ...overrides,
  };
}

function mkCall(name: string, args: object = {}, id = `call_${name}`): OpenAIToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Record-shaped mock for SupabaseService. Captures every addMessage call
 * so tests can assert the persistence sequence, and lets individual
 * tests override methods (e.g. to simulate tool behavior on memory
 * tools).
 */
interface MockSupabase {
  addMessage: ReturnType<typeof vi.fn>;
  setThreadToolboxesEnabled: ReturnType<typeof vi.fn>;
  searchMemories: ReturnType<typeof vi.fn>;
  searchMemoriesByEmbedding: ReturnType<typeof vi.fn>;
  searchUnembeddedMemoriesByText: ReturnType<typeof vi.fn>;
  createMemory: ReturnType<typeof vi.fn>;
  updateMemory: ReturnType<typeof vi.fn>;
  deleteMemory: ReturnType<typeof vi.fn>;
  // Samskara — runChatLoop calls these unconditionally per turn. The
  // defaults make the feature a no-op (no compound, no fires, no
  // substrate write) so tests written before samskara existed keep
  // passing.
  samskaraGetCompoundSummary: ReturnType<typeof vi.fn>;
  samskaraFireTopK: ReturnType<typeof vi.fn>;
  samskaraRecordFires: ReturnType<typeof vi.fn>;
  samskaraRecordSubstrate: ReturnType<typeof vi.fn>;
  // Journal - runChatLoop fetches today's automatic entry on the
  // opening turn to build the `Today's journal` appendix. Default to
  // an empty list so legacy tests keep passing.
  getJournalEntriesForDate: ReturnType<typeof vi.fn>;
  // Attachments - runChatLoop fetches a lightweight summary of every
  // attachment in the thread on every turn to build the
  // `<thread_attachments>` block. Default to empty so legacy tests
  // skip the block entirely.
  listAttachmentSummariesForThread: ReturnType<typeof vi.fn>;
  // Intuition - runChatLoop persists the cached payload here when the
  // pipeline runs successfully. Default returns undefined; tests that
  // exercise the intuition path assert the call shape.
  setThreadIntuitionPayload: ReturnType<typeof vi.fn>;
  // Context-recall - sibling of setThreadIntuitionPayload. Same default
  // (returns undefined); tests that exercise the context-recall path
  // assert the call shape.
  setThreadContextRecallPayload: ReturnType<typeof vi.fn>;
  // Recall agents - both RecallAgent and ConversationRecallAgent call
  // supabase.listMessages(threadId) at the start of their run. Default
  // returns an empty array, which makes both agents short-circuit to
  // `{kind: 'none'}` without a Venice round-trip - matching the
  // pre-feature behaviour of every test that doesn't exercise the
  // context-recall path.
  listMessages: ReturnType<typeof vi.fn>;
  // Required by the update_title tool. Default no-op so tests that
  // exercise the mid-turn title trigger succeed.
  renameThread: ReturnType<typeof vi.fn>;
}

function mockSupabase(overrides: Partial<MockSupabase> = {}): {
  svc: SupabaseService;
  mocks: MockSupabase;
  messagesOut: Message[];
} {
  const messagesOut: Message[] = [];
  let nextId = 0;
  const mocks: MockSupabase = {
    addMessage: vi.fn(async (threadId: string, role: Message['role'], content: string, opts: Record<string, unknown> = {}) => {
      const m: Message = {
        id: `m-${++nextId}`,
        thread_id: threadId,
        role,
        content,
        created_at: String(Date.now()),
        tool_calls: (opts.tool_calls as Message['tool_calls']) ?? undefined,
        tool_call_id: (opts.tool_call_id as Message['tool_call_id']) ?? undefined,
        name: (opts.name as Message['name']) ?? undefined,
        model: (opts.model as Message['model']) ?? undefined,
        usage: (opts.usage as Message['usage']) ?? undefined,
      };
      messagesOut.push(m);
      return m;
    }),
    setThreadToolboxesEnabled: vi.fn(async () => undefined),
    searchMemories: vi.fn(async () => []),
    searchMemoriesByEmbedding: vi.fn(async () => []),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
    createMemory: vi.fn(async (label: string, data: string) => ({
      id: 'mem-1',
      label,
      data,
      created_at: 't',
      updated_at: 't',
    })),
    updateMemory: vi.fn(async (id: string) => ({
      id,
      label: 'x',
      data: 'y',
      created_at: 't',
      updated_at: 't',
    })),
    deleteMemory: vi.fn(async () => undefined),
    samskaraGetCompoundSummary: vi.fn(async () => null),
    samskaraFireTopK: vi.fn(async () => []),
    samskaraRecordFires: vi.fn(async () => undefined),
    samskaraRecordSubstrate: vi.fn(async () => 'sub-stub'),
    getJournalEntriesForDate: vi.fn(async () => []),
    listAttachmentSummariesForThread: vi.fn(async () => []),
    setThreadIntuitionPayload: vi.fn(async () => undefined),
    setThreadContextRecallPayload: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => []),
    // Lets `update_title` tool calls succeed in tests that exercise the
    // mid-turn title trigger. The tool's execute path calls renameThread
    // (see src/lib/tools/update_title.ts); without this mock the tool
    // throws and the title trigger never fires.
    renameThread: vi.fn(async () => undefined),
    ...overrides,
  };
  return { svc: mocks as unknown as SupabaseService, mocks, messagesOut };
}

/**
 * Build a VeniceClient whose streamChat yields the configured events
 * for round N on its Nth invocation. Used to script a multi-round
 * conversation.
 *
 * Both `streamChat` and `completeChat` draw from the same round queue
 * - the main chat loop streams (so its rounds come off the queue as
 * SSE events) and the background sub-tools (web_search,
 * research_docs, analyze_image, the headless tool loop) call
 * completeChat (so for those rounds the helper folds the same event
 * list into a single ChatCompletion record). Tests script every round
 * the same way regardless of which path consumes it - the per-round
 * counter advances on either method.
 */
function mockVenice(roundEvents: StreamEvent[][]): VeniceClient {
  let i = 0;
  function nextRound(): StreamEvent[] {
    return roundEvents[i++] ?? [];
  }
  function eventsToCompletion(events: StreamEvent[]): ChatCompletion {
    let text = '';
    let reasoning = '';
    const toolCalls: OpenAIToolCall[] = [];
    let citations: Citation[] = [];
    let usage: TokenUsage | null = null;
    for (const ev of events) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'reasoning') reasoning += ev.delta;
      else if (ev.type === 'tool_call') toolCalls.push(ev.toolCall);
      else if (ev.type === 'citations') citations = ev.citations;
      else if (ev.type === 'usage') usage = ev.usage;
    }
    return {
      text,
      reasoning,
      toolCalls,
      usage,
      citations,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }
  return {
    async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
      const events = nextRound();
      for (const ev of events) {
        // Yield on a microtask so the consuming loop's state updates
        // interleave with delta emission - closer to real streaming.
        await Promise.resolve();
        yield ev;
      }
    },
    async completeChat(): Promise<ChatCompletion> {
      return eventsToCompletion(nextRound());
    },
    // memory_search embeds its query before running the similarity RPC;
    // any test that drives a non-empty search through the loop hits this.
    // A fixed-length zero vector keeps the shape honest without caring
    // about the contents.
    embed: vi.fn(async () => ({
      data: [{ index: 0, embedding: new Array(1024).fill(0) }],
    })),
  } as unknown as VeniceClient;
}

function summary(
  filename: string,
  mime_type: string,
  expired: boolean,
  created_at = '2026-01-01T00:00:00Z'
): ThreadAttachmentSummary {
  return {
    filename,
    mime_type,
    is_image: mime_type.startsWith('image/'),
    expired,
    created_at,
  };
}

describe('buildThreadAttachmentsBlock', () => {
  it('returns null on a thread with no attachments', () => {
    expect(buildThreadAttachmentsBlock([])).toBeNull();
  });

  it('renders only the live-images section when that is all there is', () => {
    const out = buildThreadAttachmentsBlock([
      summary('a.png', 'image/png', false),
      summary('b.jpg', 'image/jpeg', false),
    ]);
    expect(out).not.toBeNull();
    expect(out!).toContain('<thread_attachments>');
    expect(out!).toContain('Live images: a.png, b.jpg');
    expect(out!).toContain('analyze_image(filename, query)');
    // No documents or expired sections when those buckets are empty.
    expect(out!).not.toContain('Live documents:');
    expect(out!).not.toContain('Expired');
    expect(out!).toContain('</thread_attachments>');
  });

  it('renders documents and expired alongside live images', () => {
    const out = buildThreadAttachmentsBlock([
      summary('a.png', 'image/png', false),
      summary('contract.pdf', 'application/pdf', false),
      summary('old.png', 'image/png', true),
      summary('gone.pdf', 'application/pdf', true),
    ]);
    expect(out).not.toBeNull();
    expect(out!).toContain('Live images: a.png');
    expect(out!).toContain('Live documents: contract.pdf');
    expect(out!).toContain('Expired (binary reclaimed after 30d, no longer inspectable): old.png, gone.pdf');
  });

  it('promotes a re-attached filename to expired when the most recent occurrence is expired', () => {
    // Same filename appearing live first, then expired later. Block
    // should categorise it as expired - the binary really is gone now,
    // even though an earlier turn had the live version. Sorted by
    // created_at ascending, expired comes second.
    const out = buildThreadAttachmentsBlock([
      summary('shot.png', 'image/png', false, '2026-01-01T00:00:00Z'),
      summary('shot.png', 'image/png', true, '2026-02-01T00:00:00Z'),
    ]);
    expect(out).not.toBeNull();
    expect(out!).not.toContain('Live images');
    expect(out!).toContain('Expired');
    expect(out!).toContain('shot.png');
  });

  it('de-duplicates a filename that appears twice in the same bucket', () => {
    // User attaches the same screenshot.png twice across turns; both
    // remain live. The block should mention it once, not twice.
    const out = buildThreadAttachmentsBlock([
      summary('screenshot.png', 'image/png', false, '2026-01-01T00:00:00Z'),
      summary('screenshot.png', 'image/png', false, '2026-02-01T00:00:00Z'),
    ]);
    expect(out).not.toBeNull();
    // Match exactly one occurrence by checking the live-images line.
    const liveLine = out!.split('\n').find((l) => l.startsWith('Live images:'));
    expect(liveLine).toBe(
      'Live images: screenshot.png. Call analyze_image(filename, query) to inspect any of them.'
    );
  });
});

describe('toVeniceMessage', () => {
  it('projects a plain user/assistant row', () => {
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'user',
      content: 'hi',
      created_at: 't',
    };
    expect(toVeniceMessage(m)).toEqual({ role: 'user', content: 'hi' });
  });

  it('projects an assistant-with-tool-calls row', () => {
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'assistant',
      content: '',
      created_at: 't',
      tool_calls: [mkCall('memory_search')],
    };
    const out = toVeniceMessage(m);
    expect(out.tool_calls).toHaveLength(1);
    expect(out.role).toBe('assistant');
  });

  it('projects a tool-result row with id and name', () => {
    // Use an already-conforming id so this test stays focused on the
    // shape projection. The id-rewrite path that handles non-conforming
    // ids has its own coverage in tests/wire.test.ts.
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'tool',
      content: '{"ok":true}',
      created_at: 't',
      tool_call_id: 'abcdefghi',
      name: 'memory_search',
    };
    expect(toVeniceMessage(m)).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'abcdefghi',
      name: 'memory_search',
    });
  });

  // Guards the Venice 400 ("Tool call id was call_a031 but must be a-z,
  // A-Z, 0-9, with a length of 9") that some Venice-routed model
  // backends throw on tool_call_ids they generated themselves. The
  // sanitiser rewrites the id to a stable 9-char alphanumeric string
  // so the assistant tool_calls[].id and the tool result's
  // tool_call_id can be paired without tripping the validator.
  it('rewrites a non-conforming tool_call_id on a tool-result row', () => {
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'tool',
      content: '{"ok":true}',
      created_at: 't',
      tool_call_id: 'call_a031',
      name: 'memory_search',
    };
    const out = toVeniceMessage(m);
    expect(out.tool_call_id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(out.tool_call_id).not.toBe('call_a031');
  });

  // Guards the Venice 400 ("Expecting ',' delimiter: line 1 column N") we
  // saw in the wild after the `activity` param started landing free-form
  // model-written sentences inside tool-call arguments - an unescaped
  // quote in the sentence truncates the JSON string, Venice's server-side
  // json.loads rejects the whole body, and the bad arguments blob then
  // rides every subsequent replay until the thread drops that row.
  it('replaces malformed tool-call arguments with an empty object on the wire', () => {
    const badCall: OpenAIToolCall = {
      id: 'call_bad',
      type: 'function',
      function: {
        name: 'memory_search',
        // The middle `"dishwasher"` terminates the activity string early,
        // leaving the rest of the line unparseable.
        arguments: '{"activity": "Searching your memories for "dishwasher" notes", "query": "x"}',
      },
    };
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'assistant',
      content: '',
      created_at: 't',
      tool_calls: [badCall],
    };
    const out = toVeniceMessage(m);
    expect(out.tool_calls).toHaveLength(1);
    expect(out.tool_calls![0].function.arguments).toBe('{}');
    // Original call object is left untouched so the UI / DB copy still
    // shows what the model tried to emit.
    expect(badCall.function.arguments).toContain('dishwasher');
  });

  it('canonicalises well-formed tool-call arguments through parse+stringify', () => {
    const call: OpenAIToolCall = {
      id: 'call_ok',
      type: 'function',
      function: {
        name: 'memory_search',
        // Extra whitespace gets normalised away; semantics stay identical.
        arguments: '{ "query" : "dishwasher" }',
      },
    };
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'assistant',
      content: '',
      created_at: 't',
      tool_calls: [call],
    };
    const out = toVeniceMessage(m);
    expect(out.tool_calls![0].function.arguments).toBe('{"query":"dishwasher"}');
  });

  it('treats an empty arguments string as {}', () => {
    const call: OpenAIToolCall = {
      id: 'call_empty',
      type: 'function',
      function: { name: 'memory_search', arguments: '' },
    };
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'assistant',
      content: '',
      created_at: 't',
      tool_calls: [call],
    };
    const out = toVeniceMessage(m);
    expect(out.tool_calls![0].function.arguments).toBe('{}');
  });
});

describe('formatRelativeDuration', () => {
  // Buckets matching the formatter's decision tree. The model uses
  // these as a register-calibration signal, not for arithmetic, so
  // the values are deliberately coarse - the goal is for "yesterday"
  // and "about 3 days" to obviously read as a stale-thread revival
  // while "a few minutes" and "just now" read as a live continuation.
  const fmt = chatLoopTest.formatRelativeDuration;
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HR = 60 * MIN;
  const DAY = 24 * HR;

  it('returns "just now" for <2 minutes and for clock skew', () => {
    expect(fmt(0)).toBe('just now');
    expect(fmt(30 * SEC)).toBe('just now');
    expect(fmt(119 * SEC)).toBe('just now');
    // Negative ms = anchor is in the future relative to now. Can
    // happen when the DB stamped created_at server-side and the
    // browser clock is slightly behind; ship "just now" rather than
    // "in 4 seconds".
    expect(fmt(-5 * SEC)).toBe('just now');
    expect(fmt(NaN)).toBe('just now');
  });

  it('returns "a few minutes" for 2-10 minutes', () => {
    expect(fmt(2 * MIN)).toBe('a few minutes');
    expect(fmt(9 * MIN)).toBe('a few minutes');
  });

  it('returns "about N minutes" for 10-60 minutes', () => {
    expect(fmt(10 * MIN)).toBe('about 10 minutes');
    expect(fmt(45 * MIN)).toBe('about 45 minutes');
    expect(fmt(59 * MIN)).toBe('about 59 minutes');
  });

  it('singularizes the hour bucket', () => {
    expect(fmt(60 * MIN)).toBe('about an hour');
    expect(fmt(119 * MIN)).toBe('about an hour');
  });

  it('returns "about N hours" for 2-24 hours', () => {
    expect(fmt(2 * HR)).toBe('about 2 hours');
    expect(fmt(22 * HR)).toBe('about 22 hours');
  });

  it('returns "yesterday" for 24-48 hours', () => {
    expect(fmt(24 * HR)).toBe('yesterday');
    expect(fmt(36 * HR)).toBe('yesterday');
  });

  it('returns "about N days" for 2-14 days', () => {
    expect(fmt(2 * DAY)).toBe('about 2 days');
    expect(fmt(13 * DAY)).toBe('about 13 days');
  });

  it('returns "about N weeks" for 14-60 days', () => {
    expect(fmt(14 * DAY)).toBe('about 2 weeks');
    expect(fmt(59 * DAY)).toBe('about 8 weeks');
  });

  it('returns "about N months" for 60 days to a year', () => {
    expect(fmt(60 * DAY)).toBe('about 2 months');
    expect(fmt(300 * DAY)).toBe('about 10 months');
  });

  it('returns "over a year" beyond ~12 months', () => {
    expect(fmt(365 * DAY)).toBe('over a year');
    expect(fmt(5 * 365 * DAY)).toBe('over a year');
  });
});

describe('runChatLoop', () => {
  it('forwards reasoningEffort to every streamChat call', async () => {
    // The loop doesn't gate on ModelSpec.supportsReasoning — that's the
    // caller's job. So whatever reasoningEffort is passed in rides along
    // on every round.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      reasoningEffort: 'medium',
    });
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].reasoningEffort).toBe('medium');
  });

  it('leaves reasoningEffort unset on streamChat when the caller omits it', async () => {
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });
    expect(seenRequests[0].reasoningEffort).toBeUndefined();
  });

  it('puts the emphasis-markdown blurb in the metadata system message when emphasisMarkdown=true', async () => {
    // When the user has the "Emphasis markdown" toggle on, the
    // per-turn metadata system message carries a short formatting
    // instruction telling the model to sprinkle light Markdown
    // emphasis through its reply so long answers skim better. We
    // assert on a distinctive phrase from the blurb so a later
    // wording tweak surfaces here and gets a deliberate review
    // rather than silently changing user-visible model behaviour.
    //
    // The metadata message is the second system message in the wire
    // (baseline at [0], metadata at [1] when no user-configured
    // system prompts are active).
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      emphasisMarkdown: true,
    });
    const meta = seenRequests[0].messages[1];
    expect(meta.role).toBe('system');
    expect(typeof meta.content).toBe('string');
    expect(meta.content as string).toContain('scan-points');
    // The baseline at messages[0] must stay free of the nudge so
    // users without the toggle never see it.
    expect(seenRequests[0].messages[0].content as string).not.toContain('scan-points');
  });

  it('omits the emphasis-markdown blurb when the flag is false or absent', async () => {
    // Opt-in: the metadata system message stays free of the formatting
    // nudge for users who haven't turned it on. Two sub-cases both
    // matter - explicit false (user flipped it off) and absent (older
    // caller or test that predates the option).
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      emphasisMarkdown: false,
    });
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      // emphasisMarkdown intentionally omitted.
    });
    expect(seenRequests).toHaveLength(2);
    for (const req of seenRequests) {
      // Neither the baseline nor the metadata message should carry
      // the formatting nudge when the toggle is off / absent.
      for (const m of req.messages) {
        if (m.role !== 'system') continue;
        expect(m.content as string).not.toContain('scan-points');
      }
    }
  });

  it('renders the user profile in the metadata system message when userName / userLocation is set', async () => {
    // Profile fields ride along with every reply this account sends,
    // as the lead paragraph of the per-turn metadata system message.
    // Both values are passed through verbatim - the chat-loop treats
    // them as free-form prose, not a schema.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      userName: 'Ada',
      userLocation: 'Lisbon',
    });
    const meta = seenRequests[0].messages[1];
    expect(meta.role).toBe('system');
    expect(typeof meta.content).toBe('string');
    const content = meta.content as string;
    expect(content).toContain("User's name: Ada");
    expect(content).toContain("User's location: Lisbon");
  });

  it('renders only the populated profile field when one is empty', async () => {
    // Asymmetric: a user supplied just their name but not a location.
    // The block still renders (the model gets the name) but the
    // missing field stays out so the model isn't tempted to invent
    // one.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      userName: 'Ada',
      userLocation: '',
    });
    const content = seenRequests[0].messages[1].content as string;
    expect(content).toContain("User's name: Ada");
    expect(content).not.toContain("User's location");
  });

  it('omits the user profile paragraph from the metadata system message when both fields are blank or absent', async () => {
    // Fresh-account / opted-out path. Both empty strings and an
    // outright omission of the option keys must skip the profile
    // sentences so the metadata message opens directly with the
    // wall-clock paragraph.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      userName: '',
      userLocation: '',
    });
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      // Intentionally no userName / userLocation - older callers
      // (and tests written before the feature) must keep working.
    });
    expect(seenRequests).toHaveLength(2);
    for (const req of seenRequests) {
      const meta = req.messages[1].content as string;
      expect(meta).not.toContain("User's name");
      expect(meta).not.toContain("User's location");
    }
  });

  it('passes every user turn through bare - no <user_message> fence, no embedded datetime tag', async () => {
    // Earlier shapes wrapped the current user turn in
    // <user_message>...</user_message> with a `<datetime>` tag prepended
    // outside the fence. That structural workaround existed because
    // Venice's auto-URL-scraping (`enable_web_scraping`, always-on at
    // the time) inlined reference material alongside the user's typed
    // words, and the model needed a fence to tell its anchor apart
    // from the injection. URL handling now routes through the
    // `web_search` tool and the scraping flag is gated, so the fence
    // came off: the user message rides bare, the role:user boundary
    // is the signal, and platform context lives in a dedicated
    // metadata system message at messages[1].
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [
        { role: 'user', content: 'older turn' },
        { role: 'assistant', content: 'older reply' },
        { role: 'user', content: 'look up X' },
      ],
      signal: new AbortController().signal,
    });
    const msgs = seenRequests[0].messages;
    expect(msgs[0].role).toBe('system');
    const users = msgs.filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[0].content).toBe('older turn');
    expect(users[1].content).toBe('look up X');
    // No fence or datetime XML tag should appear anywhere in the
    // request, even on the metadata system message (where datetime
    // now rides as a prose sentence, not a tag).
    for (const m of msgs) {
      const text = typeof m.content === 'string' ? m.content : '';
      expect(text).not.toContain('<user_message>');
      expect(text).not.toContain('<datetime ');
    }
  });

  it('never sets webSearch or webCitations on the outer stream request', async () => {
    // The main chat loop is web-search-agnostic now. Every request
    // goes out with `venice_parameters.enable_web_search` unset so
    // Venice doesn't run a search on the model's behalf. Live search
    // only happens through the `web_search` tool, which runs its own
    // sub-completion with the flags set.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });
    expect(seenRequests[0].webSearch).toBeUndefined();
    expect(seenRequests[0].webCitations).toBeUndefined();
  });

  it('does not mutate the caller-supplied history', async () => {
    // The loop rebuilds requestMessages every round (with the metadata
    // system message and synthetic <think> blocks projected in), so
    // history projection has to allocate fresh arrays rather than
    // edit the caller's VeniceMessage objects in place. If we
    // mutated, a second runChatLoop invocation - or the caller
    // reusing the history array - would see leftover edits.
    const venice = {
      async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    const history = [{ role: 'user' as const, content: 'look up X' }];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history,
      signal: new AbortController().signal,
    });
    expect(history[0].content).toBe('look up X');
  });

  it('passes multimodal user content through unchanged - no fence around the ContentPart array', async () => {
    // Vision-capable user turns ride as `[{type:'text',text:'...'},
    // {type:'image_url', image_url:{url:'...'}}]`. The old fence
    // bracketed the array with `<user_message>` text parts; the new
    // shape leaves the user's content intact and lets the role:user
    // boundary do the work. Platform context (datetime, attachments
    // inventory) rides in the metadata system message instead.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
      signal: new AbortController().signal,
    });
    const userMsg = seenRequests[0].messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const parts = userMsg!.content as Array<{ type: string; text?: string; image_url?: unknown }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'what is in this image?' });
    expect(parts[1].type).toBe('image_url');
  });

  it('puts the wall-clock paragraph in the metadata system message with local + UTC + IANA zone', async () => {
    // The model has no clock without an injected timestamp. The
    // per-turn metadata system message opens with a wall-clock prose
    // paragraph (local ISO 8601 with offset, IANA zone label, UTC
    // form) so "what year is it?" and "what time is it?" land
    // correctly without the model falling back to training-cutoff
    // knowledge.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'what time is it?' }],
      journalTimezone: 'America/Los_Angeles',
      signal: new AbortController().signal,
    });
    const meta = seenRequests[0].messages[1].content as string;
    // Local ISO 8601 with offset (e.g. '2026-04-24T15:30:00-07:00' or
    // -08:00 depending on DST), the IANA zone label verbatim, and
    // the UTC Z form all sit in one sentence.
    expect(meta).toMatch(
      /Current local time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \(zone America\/Los_Angeles; UTC \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)\./,
    );
  });

  it('falls back to a usable zone label when journalTimezone is null', async () => {
    // No configured timezone falls back to the runtime's reported
    // zone; in the Vitest environment that's typically UTC. The
    // important contract is that the wall-clock paragraph lands with
    // a non-empty zone label and a parseable local ISO offset.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });
    const meta = seenRequests[0].messages[1].content as string;
    const m = /Current local time: ([^ ]+) \(zone ([^;]+); UTC ([^)]+)\)\./.exec(meta);
    expect(m).not.toBeNull();
    const [, local, zone, utc] = m!;
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/);
    expect(utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(zone.length).toBeGreaterThan(0);
  });

  it('omits the since-last-reply sentence on the opening turn', async () => {
    // Opening turn = no prior assistant message to anchor against,
    // so the caller passes lastAssistantTimestamp=null (or omits it).
    // The metadata message ships only the wall-clock paragraph, no
    // "About X since your last reply" trailing sentence.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      lastAssistantTimestamp: null,
      signal: new AbortController().signal,
    });
    const meta = seenRequests[0].messages[1].content as string;
    expect(meta).toContain('Current local time:');
    expect(meta).not.toContain('since your last reply');
  });

  it('includes the since-last-reply sentence when lastAssistantTimestamp is supplied', async () => {
    // Mid-thread turns carry a coarse human-friendly elapsed string
    // so the model can calibrate register ("you just answered" vs
    // "it's been a few days"). The elapsed bucket is "about 22
    // hours" for a 22-hour-old anchor; exact wording is the
    // formatter's job and is covered separately.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    // 22 hours ago - "about 22 hours" bucket.
    const anchor = new Date(Date.now() - 22 * 60 * 60 * 1000).toISOString();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      lastAssistantTimestamp: anchor,
      signal: new AbortController().signal,
    });
    const meta = seenRequests[0].messages[1].content as string;
    expect(meta).toContain('Your last reply on this thread was about 22 hours ago.');
  });

  it('omits the since-last-reply sentence when lastAssistantTimestamp is unparseable', async () => {
    // A corrupt / unexpected timestamp string (Date.parse returns NaN)
    // is treated as "no anchor available" rather than emitting a
    // garbage value. The wall-clock paragraph still rides; only the
    // elapsed sentence is dropped.
    const seenRequests: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seenRequests.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      lastAssistantTimestamp: 'not-a-date',
      signal: new AbortController().signal,
    });
    const meta = seenRequests[0].messages[1].content as string;
    expect(meta).toContain('Current local time:');
    expect(meta).not.toContain('since your last reply');
  });

  it('persists a plain text response in one round', async () => {
    const venice = mockVenice([
      [{ type: 'text', delta: 'Hello' }, { type: 'text', delta: ' there' }],
    ]);
    const { svc, messagesOut } = mockSupabase();
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });
    expect(result.finalText).toBe('Hello there');
    expect(result.roundsRun).toBe(1);
    expect(result.stoppedByLimit).toBe(false);
    expect(messagesOut).toHaveLength(1);
    expect(messagesOut[0]).toMatchObject({ role: 'assistant', content: 'Hello there' });
  });

  it('persists partial text with the interrupted marker when the stream aborts mid-round', async () => {
    // User clicks stop after a few text deltas have arrived but before
    // the stream finishes. Chat-loop catches the AbortError inside the
    // round loop, appends the marker to whatever text / reasoning
    // accumulated, and returns `{ interrupted: true }`. The partial
    // row is persisted so the user can see exactly where the reply
    // was cut.
    const controller = new AbortController();
    // Streaming mock: yield two deltas synchronously, then on the
    // third pull abort the signal and throw the spec-shaped AbortError
    // that fetch's ReadableStream rejects with. This mirrors the real
    // flow where the reader.read() rejects after signal.abort().
    const venice = {
      async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'text', delta: 'Hello ' };
        yield { type: 'text', delta: 'there, I was saying' };
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
      embed: vi.fn(async () => ({
        data: [{ index: 0, embedding: new Array(1024).fill(0) }],
      })),
    } as unknown as VeniceClient;
    const { svc, messagesOut, mocks } = mockSupabase();
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    expect(result.interrupted).toBe(true);
    expect(result.stoppedByLimit).toBe(false);
    expect(result.finalText).toBe('Hello there, I was saying');
    expect(messagesOut).toHaveLength(1);
    expect(messagesOut[0].role).toBe('assistant');
    expect(messagesOut[0].content).toBe(
      `Hello there, I was saying\n\n${INTERRUPTED_MARKER}`
    );
    // Tool-call fragments are internal to venice.ts and never surface as
    // tool_call events mid-stream, so the persisted row must not carry
    // any tool_calls — any accumulated-but-unexecuted calls are dropped.
    const [, , , opts] = mocks.addMessage.mock.calls[0];
    expect((opts as Record<string, unknown>).tool_calls).toBeUndefined();
  });

  it('skips persistence when the stream aborts before any content arrived', async () => {
    // No deltas made it through before the abort - the user clicked
    // stop so quickly that nothing was streamed. Skip the assistant
    // row entirely so the conversation doesn't accumulate a ghost
    // bubble containing only the marker.
    const controller = new AbortController();
    const venice = {
      async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
      embed: vi.fn(async () => ({
        data: [{ index: 0, embedding: new Array(1024).fill(0) }],
      })),
    } as unknown as VeniceClient;
    const { svc, messagesOut } = mockSupabase();
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    expect(result.interrupted).toBe(true);
    expect(messagesOut).toHaveLength(0);
  });

  it('persists the marker as standalone content on a reasoning-only interrupt', async () => {
    // Reasoning-capable models can stream their thinking before any
    // visible answer tokens appear. Aborting during that phase means
    // roundText is empty but roundReasoning holds real content - we
    // still persist the row so the reasoning panel survives a refresh,
    // and the content field shows the marker on its own so the bubble
    // renders something.
    const controller = new AbortController();
    const venice = {
      async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'reasoning', delta: 'weighing the ' };
        yield { type: 'reasoning', delta: 'options...' };
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
      embed: vi.fn(async () => ({
        data: [{ index: 0, embedding: new Array(1024).fill(0) }],
      })),
    } as unknown as VeniceClient;
    const { svc, messagesOut, mocks } = mockSupabase();
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    expect(result.interrupted).toBe(true);
    expect(messagesOut).toHaveLength(1);
    expect(messagesOut[0].content).toBe(INTERRUPTED_MARKER);
    const [, , , opts] = mocks.addMessage.mock.calls[0];
    expect((opts as Record<string, unknown>).reasoning).toBe('weighing the options...');
  });

  it('rethrows non-abort errors instead of swallowing them as interrupts', async () => {
    // A mid-stream network failure is NOT an abort - let the outer
    // runExchange catch it and surface an error banner. Only
    // AbortError / signal.aborted routes through the interrupted
    // branch.
    const venice = {
      async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'text', delta: 'partial' };
        throw new Error('connection reset');
      },
      embed: vi.fn(async () => ({
        data: [{ index: 0, embedding: new Array(1024).fill(0) }],
      })),
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await expect(
      runChatLoop({
        venice,
        supabase: svc,
        thread: mkThread(),
        userId: 'u-1',
        modelId: 'm',
        history: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('connection reset');
  });

  it('persists reasoning and citations on the assistant row', async () => {
    // Reasoning-capable models on a web-search turn produce three
    // event types we care about: reasoning deltas, the citations
    // list (once), and visible text. All three must land on the
    // persisted row so a page refresh restores the full UI — the
    // collapsible thought panel, the citation superscripts in the
    // body, and the source list under the action bar.
    const venice = mockVenice([
      [
        { type: 'reasoning', delta: 'weighing ' },
        { type: 'reasoning', delta: 'options...' },
        {
          type: 'citations',
          citations: [
            { index: 1, url: 'https://a.example', title: 'A' },
          ],
        },
        { type: 'text', delta: 'Per source ^1^.' },
      ],
    ]);
    const { svc, mocks } = mockSupabase();
    const reasoningSeen: string[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      handlers: {
        onReasoningUpdate: (t) => reasoningSeen.push(t),
      },
    });
    // Cumulative accumulation: each callback sees the growing string.
    expect(reasoningSeen).toEqual(['weighing ', 'weighing options...']);
    expect(mocks.addMessage).toHaveBeenCalledOnce();
    const [, , , opts] = mocks.addMessage.mock.calls[0];
    expect(opts).toMatchObject({
      reasoning: 'weighing options...',
      citations: [{ index: 1, url: 'https://a.example', title: 'A' }],
    });
  });

  it('harvests tool-sourced citations and persists them on the terminal assistant row', async () => {
    // The web_search tool returns `{answer, citations}`. Chat-loop
    // inspects each tool result, accumulates the citations into a
    // turn-scoped list with contiguous 1-based indexes, and persists
    // them on the final assistant row's `citations` column. That's
    // how the same CitationsPanel / ^N^ superscript rendering the old
    // always-on search path used keeps working when search is a tool
    // call instead of a venice_parameter.
    //
    // Round sequence in the mocked Venice queue:
    //   R1 (main chat)    : model emits a web_search tool_call
    //   R2 (sub-call)     : web_search.execute() runs a nested
    //                        streamChat that yields text + citations
    //   R3 (main chat)    : model sees the tool result, emits final text
    const call = mkCall('web_search', { query: 'current bitcoin price' });
    const citations: Citation[] = [
      { index: 1, url: 'https://coinbase.example/btc', title: 'BTC price' },
    ];
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: call }],
      [
        { type: 'text', delta: 'Bitcoin is around $70k today.' },
        { type: 'citations', citations },
      ],
      [{ type: 'text', delta: 'Bitcoin is at ~$70k today ^1^.' }],
    ]);
    const { svc, mocks } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: [] }),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'what is btc at' }],
      signal: new AbortController().signal,
    });
    // Last addMessage call is the terminal assistant row; its opts
    // carry the harvested citations.
    const addCalls = mocks.addMessage.mock.calls;
    const finalCall = addCalls[addCalls.length - 1];
    expect(finalCall[1]).toBe('assistant');
    expect(finalCall[3].citations).toEqual([
      {
        index: 1,
        url: 'https://coinbase.example/btc',
        title: 'BTC price',
      },
    ]);
  });

  it('renumbers citations contiguously across multiple web_search calls in one round', async () => {
    // Two web_search invocations in parallel, each returning a
    // single index=1 citation. The harvester has to rewrite indexes
    // so the rendered panel reads 1, 2 — not 1, 1. Matches the
    // CitationsPanel's expectation that indexes are unique within a
    // message.
    //
    // Round sequence:
    //   R1 main : two parallel web_search tool_calls
    //   R2 / R3 : sub-calls for each web_search (order not guaranteed
    //             because the tools run concurrently, but the content
    //             each yields is equivalent for this assertion)
    //   R4 main : final text
    const c1 = mkCall('web_search', { query: 'a' }, 'call_a');
    const c2 = mkCall('web_search', { query: 'b' }, 'call_b');
    const venice = mockVenice([
      [
        { type: 'tool_call', toolCall: c1 },
        { type: 'tool_call', toolCall: c2 },
      ],
      [
        { type: 'text', delta: 'first' },
        {
          type: 'citations',
          citations: [{ index: 1, url: 'https://example.com/x' }],
        },
      ],
      [
        { type: 'text', delta: 'second' },
        {
          type: 'citations',
          citations: [{ index: 1, url: 'https://example.com/y' }],
        },
      ],
      [{ type: 'text', delta: 'done' }],
    ]);
    const { svc, mocks } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: [] }),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'q' }],
      signal: new AbortController().signal,
    });
    const addCalls = mocks.addMessage.mock.calls;
    const finalCall = addCalls[addCalls.length - 1];
    const finalCitations = finalCall[3].citations as Citation[];
    expect(finalCitations.map((c) => c.index)).toEqual([1, 2]);
    // Every citation's `url` survived the renumbering intact.
    expect(finalCitations.every((c) => typeof c.url === 'string' && c.url.length > 0)).toBe(true);
  });

  it('persists null reasoning when the turn produced none', async () => {
    // Non-reasoning models never emit `delta.reasoning_content`. We
    // still write the column — as null — so older rows (before the
    // column existed) stay distinguishable from rows that had no
    // reasoning on this specific turn.
    const venice = mockVenice([[{ type: 'text', delta: 'hi' }]]);
    const { svc, mocks } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'q' }],
      signal: new AbortController().signal,
    });
    const [, , , opts] = mocks.addMessage.mock.calls[0];
    expect(opts).toMatchObject({ reasoning: null, citations: null });
  });

  it('runs a round of tool calls then a final text round', async () => {
    const call = mkCall('memory_search', { query: 'cat' });
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: call }],
      [{ type: 'text', delta: 'You have a cat named Whiskers.' }],
    ]);
    const { svc, mocks, messagesOut } = mockSupabase({
      // memory_search with a non-empty query now runs vector search;
      // route the hit through the embedding-backed path.
      searchMemoriesByEmbedding: vi.fn(async () => [
        { id: 'mem-1', label: 'cat', data: 'Whiskers', created_at: 't', updated_at: 't' },
      ]),
    });
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: ['cooking', 'memories', 'conversations'] }),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'what is my cat named?' }],
      signal: new AbortController().signal,
    });
    expect(result.finalText).toBe('You have a cat named Whiskers.');
    expect(result.roundsRun).toBe(2);
    // Persisted order: assistant-with-tool-calls, tool result, final assistant
    expect(messagesOut.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(messagesOut[0].tool_calls).toHaveLength(1);
    expect(messagesOut[1].tool_call_id).toBe(call.id);
    expect(messagesOut[1].name).toBe('memory_search');
    expect(mocks.searchMemoriesByEmbedding).toHaveBeenCalledOnce();
  });

  it('executes parallel tool calls concurrently', async () => {
    const calls = [mkCall('memory_search', {}, 'c0'), mkCall('memory_search', {}, 'c1')];
    const venice = mockVenice([
      calls.map((c) => ({ type: 'tool_call' as const, toolCall: c })),
      [{ type: 'text', delta: 'done' }],
    ]);
    // Each searchMemories call sleeps 50ms. If calls were serialized the
    // round would take ~100ms; concurrent execution keeps it near 50ms.
    const { svc } = mockSupabase({
      searchMemories: vi.fn(
        () => new Promise((r) => setTimeout(() => r([]), 50))
      ),
    });
    const start = Date.now();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: ['cooking', 'memories', 'conversations'] }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - start;
    // Generous upper bound — CI latency adds jitter, but serial would
    // be ~100ms+ which clears 85ms with headroom.
    expect(elapsed).toBeLessThan(85);
  });

  it('updates toolboxes_enabled when the model calls toggle_toolbox', async () => {
    const venice = mockVenice([
      [
        {
          type: 'tool_call',
          toolCall: mkCall('toggle_toolbox', { enabled: ['cooking', 'memories'] }),
        },
      ],
      [{ type: 'text', delta: 'Toolboxes are ready.' }],
    ]);
    const { svc, mocks } = mockSupabase();
    const changes: readonly string[][] = [];
    const recorded: string[][] = [];
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: {
        onToolboxesEnabledChange: (enabled) => {
          recorded.push([...enabled]);
        },
      },
    });
    void changes;
    expect(result.toolboxesEnabled).toEqual(['cooking', 'memories']);
    expect(recorded).toEqual([['cooking', 'memories']]);
    expect(mocks.setThreadToolboxesEnabled).toHaveBeenCalledWith('t-1', [
      'cooking',
      'memories',
    ]);
  });

  it('does not fire onToolboxesEnabledChange when toggle_toolbox is a no-op', async () => {
    // Calling toggle_toolbox with the same array the thread already
    // has should persist (the model re-affirms its intent) but the UI
    // notification must not flash - nothing visible changed.
    const venice = mockVenice([
      [
        {
          type: 'tool_call',
          toolCall: mkCall('toggle_toolbox', { enabled: ['cooking'] }),
        },
      ],
      [{ type: 'text', delta: 'OK.' }],
    ]);
    const { svc } = mockSupabase();
    const recorded: string[][] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: ['cooking'] }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: {
        onToolboxesEnabledChange: (enabled) => {
          recorded.push([...enabled]);
        },
      },
    });
    expect(recorded).toEqual([]);
  });

  it('surfaces a tool error via onToolError and as a tool-result row', async () => {
    const call = mkCall('memory_search', {});
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: call }],
      [{ type: 'text', delta: 'sorry, failed' }],
    ]);
    const { svc, messagesOut } = mockSupabase({
      searchMemories: vi.fn(async () => {
        throw new Error('db is down');
      }),
    });
    const errors: Error[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: ['cooking', 'memories', 'conversations'] }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: {
        onToolError: (_c, err) => errors.push(err),
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/db is down/);
    // The tool-result row carries a JSON-encoded error payload, so the
    // model sees structured failure rather than a stringified Error.
    const toolMsg = messagesOut.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/db is down/);
    expect(JSON.parse(toolMsg!.content)).toEqual({ error: 'db is down' });
  });

  it('stops at MAX_ROUNDS if the model never produces a terminal response', async () => {
    // Every round is a tool call — the model never gives up.
    const rounds: StreamEvent[][] = [];
    for (let i = 0; i < MAX_ROUNDS + 2; i++) {
      rounds.push([
        {
          type: 'tool_call',
          toolCall: mkCall('memory_search', {}, `c${i}`),
        },
      ]);
    }
    const venice = mockVenice(rounds);
    const { svc } = mockSupabase();
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: ['cooking', 'memories', 'conversations'] }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
    });
    expect(result.stoppedByLimit).toBe(true);
    expect(result.roundsRun).toBe(MAX_ROUNDS);
  });

  it('fires onTextUpdate with cumulative round text', async () => {
    const venice = mockVenice([
      [
        { type: 'text', delta: 'He' },
        { type: 'text', delta: 'llo' },
        { type: 'text', delta: '!' },
      ],
    ]);
    const { svc } = mockSupabase();
    const updates: string[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: { onTextUpdate: (t) => updates.push(t) },
    });
    expect(updates).toEqual(['He', 'Hello', 'Hello!']);
  });

  it('invokes onAssistantPersisted and onToolResultPersisted in order', async () => {
    const call = mkCall('memory_search', {});
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: call }],
      [{ type: 'text', delta: 'final' }],
    ]);
    const { svc } = mockSupabase();
    const order: string[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: ['cooking', 'memories', 'conversations'] }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: {
        onAssistantPersisted: () => order.push('assistant'),
        onToolResultPersisted: () => order.push('tool'),
      },
    });
    expect(order).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('persists model id and usage on a plain text assistant row', async () => {
    const venice = mockVenice([
      [
        { type: 'text', delta: 'hi' },
        {
          type: 'usage',
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      ],
    ]);
    const { svc, messagesOut } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'kimi-k2-5',
      history: [],
      signal: new AbortController().signal,
    });
    expect(messagesOut).toHaveLength(1);
    expect(messagesOut[0].model).toBe('kimi-k2-5');
    expect(messagesOut[0].usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
  });

  it('persists model id and usage on an assistant-with-tool-calls row', async () => {
    // Tool-call turns burn tokens too; the indicator should be able to
    // reflect that even though the content-less assistant row won't
    // surface the ring in the UI.
    const call = mkCall('memory_search', {});
    const venice = mockVenice([
      [
        { type: 'tool_call', toolCall: call },
        {
          type: 'usage',
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        },
      ],
      [{ type: 'text', delta: 'done' }],
    ]);
    const { svc, messagesOut } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: ['cooking', 'memories', 'conversations'] }),
      userId: 'u-1',
      modelId: 'zai-org-glm-5',
      history: [],
      signal: new AbortController().signal,
    });
    const firstAssistant = messagesOut.find(
      (m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0
    );
    expect(firstAssistant?.model).toBe('zai-org-glm-5');
    expect(firstAssistant?.usage?.total_tokens).toBe(110);
  });

  it('leaves usage undefined when the stream skipped the epilogue', async () => {
    const venice = mockVenice([[{ type: 'text', delta: 'hi' }]]);
    const { svc, messagesOut } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'kimi-k2-5',
      history: [],
      signal: new AbortController().signal,
    });
    expect(messagesOut[0].model).toBe('kimi-k2-5');
    // The chat-loop passes `usage: null` when no epilogue arrived; the
    // mock's `?? undefined` fallback normalizes that to undefined,
    // matching how a freshly-inserted row would deserialize.
    expect(messagesOut[0].usage).toBeUndefined();
  });

  it('handles malformed JSON arguments as a tool error', async () => {
    const bogus: OpenAIToolCall = {
      id: 'c0',
      type: 'function',
      function: { name: 'memory_search', arguments: '{not json' },
    };
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: bogus }],
      [{ type: 'text', delta: 'ok' }],
    ]);
    const { svc, messagesOut } = mockSupabase();
    const errors: Error[] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ toolboxes_enabled: ['cooking', 'memories', 'conversations'] }),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: { onToolError: (_c, err) => errors.push(err) },
    });
    expect(errors).toHaveLength(1);
    const toolMsg = messagesOut.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    // A parse failure still produces a tool-result row so the history
    // stays valid for a future replay.
    expect(JSON.parse(toolMsg!.content)).toHaveProperty('error');
  });

  // ---------------------------------------------------------------
  // Title-rename directives.
  //
  // The chat loop nudges the model to call `update_title` through the
  // per-turn metadata system message (the second system row in the
  // wire shape, immediately before the user turn). Two shapes:
  //
  //   - Placeholder ("New conversation"): a paragraph telling the
  //     model to call `update_title` with a 3-6 word topic title
  //     before replying. Fires from round 2 onward only - on the
  //     opening turn the background title-gen pipeline owns naming
  //     (see Chat.svelte), so the metadata nudge stays silent there
  //     to avoid double-titling.
  //   - Real model-set title: a terse "rename if the topic shifted"
  //     one-liner. Same round-2+ gate; cosmetic drift on a fresh
  //     thread is not the metadata message's job.
  //   - Manually-set title: nothing. Once the user commits to a
  //     title, the model must not clobber their choice on any
  //     round.
  //
  // Both nudges sit in the metadata system message (NOT in the
  // baseline prompt, NOT in the user turn). The user message rides
  // bare in the new wire shape - no <system_reminder> fence, no
  // user_message tags.
  // ---------------------------------------------------------------

  function metadataMessage(seen: ChatRequest[]): string {
    // The per-turn metadata system message is the LAST system row
    // before any user/assistant message. With no user-configured
    // system prompts in the test fixtures, that's messages[1].
    const msgs = seen[0].messages;
    let lastSystemIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'system') lastSystemIdx = i;
      else break;
    }
    if (lastSystemIdx < 1) {
      throw new Error('expected a metadata system message after the baseline');
    }
    const content = msgs[lastSystemIdx].content;
    if (typeof content !== 'string') {
      throw new Error('metadata system message content must be a string');
    }
    return content;
  }

  /**
   * Joined text content of the last `role: 'user'` message in the
   * first captured request. Multimodal content's text parts are
   * concatenated so a single includes() / not.toContain() assertion
   * can scan across them.
   */
  function lastUserContent(seen: ChatRequest[]): string {
    const msgs = seen[0].messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      return m.content
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n');
    }
    throw new Error('expected a user message in the request');
  }

  it('keeps the metadata message silent about titles on the opening turn even when the thread is still the placeholder', async () => {
    // Round 1: the background title-gen pipeline in Chat.svelte fires
    // a parallel completion to name the thread. The chat-loop's
    // metadata nudge would just compete and risk double-titling, so
    // it stays silent on this round. Placeholder threads only see
    // the chat-loop's nag from round 2 on (if the background pipeline
    // somehow didn't land a title).
    const seen: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seen.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ title: 'New conversation', title_manually_set: false }),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'help me with python decorators' }],
      signal: new AbortController().signal,
    });
    const meta = metadataMessage(seen);
    expect(meta).not.toContain('update_title');
    expect(meta).not.toContain('New conversation');
    // The user turn ships bare in the new wire shape.
    const userText = lastUserContent(seen);
    expect(userText).toBe('help me with python decorators');
  });

  it('puts the placeholder title nag in the metadata system message from round 2 onward', async () => {
    // Round 2+ with a placeholder title: the background title-gen
    // pipeline didn't land a title (network blip, model timeout,
    // user manually reset to the placeholder), so the chat-loop's
    // metadata nudge fires the loud nag. The directive lives in the
    // metadata system message at messages[1] (last system row before
    // the user turn); the user message itself stays bare.
    const seen: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seen.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ title: 'New conversation', title_manually_set: false }),
      userId: 'u-1',
      modelId: 'm',
      // round 2: prior user/assistant turn already in history.
      history: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'help me with python decorators' },
      ],
      signal: new AbortController().signal,
    });
    const meta = metadataMessage(seen);
    expect(meta).toContain('update_title');
    expect(meta).toContain('placeholder');
    expect(meta).toContain('New conversation');
    // Nothing should ride inside the user turn - the fence and
    // <system_reminder> shape went away with the wire-shape refactor.
    const userText = lastUserContent(seen);
    expect(userText).toBe('help me with python decorators');
    expect(userText).not.toContain('<system_reminder>');
    expect(userText).not.toContain('<user_message>');
  });

  it('omits the title directives entirely when the user has manually named the thread', async () => {
    // title_manually_set=true is the sticky flag commitRename flips
    // in Chat.svelte. Once the user has committed to a title, the
    // chat loop must stop asking the model to rename it - otherwise
    // the model could clobber the user's choice. The `update_title`
    // tool stays in the always-on catalog (no harm; model won't call
    // it without the instruction), but the metadata message must
    // not nudge.
    const seen: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seen.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ title: 'Python decorators', title_manually_set: true }),
      userId: 'u-1',
      modelId: 'm',
      // Round 2 setup to exercise the round-gate: if the metadata
      // message ever fires title nudges, this is the round that
      // would surface them. They must stay silent on a manually-named
      // thread regardless of round.
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'another question' },
      ],
      signal: new AbortController().signal,
    });
    const meta = metadataMessage(seen);
    expect(meta).not.toContain('update_title');
    expect(meta).not.toContain('meaningfully shifted');
    expect(meta).not.toContain('Current conversation title');
    // The current title itself must not appear in the metadata
    // message - the model has no business knowing it for the
    // purpose of renaming.
    expect(meta).not.toContain('Python decorators');
    const userText = lastUserContent(seen);
    expect(userText).toBe('another question');
    expect(userText).not.toContain('<system_reminder>');
  });

  it('puts the topic-shift hint in the metadata system message when the thread already has a model-set title (round 2+)', async () => {
    // Non-placeholder + not-manually-set + round 2+: the model
    // already picked a title; this is the low-urgency "rename if
    // the topic shifted" hint. Lives in the metadata system message
    // alongside the placeholder nag; round 1 stays silent because
    // the background title-gen pipeline owns naming there.
    const seen: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seen.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase();
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ title: 'Python decorators', title_manually_set: false }),
      userId: 'u-1',
      modelId: 'm',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'follow up question' },
      ],
      signal: new AbortController().signal,
    });
    const meta = metadataMessage(seen);
    expect(meta).toContain('Python decorators');
    expect(meta).toContain('update_title');
    expect(meta).toContain('meaningfully shifted');
    // Soft hint, not the loud placeholder nag.
    expect(meta).not.toContain('placeholder');
    const userText = lastUserContent(seen);
    expect(userText).toBe('follow up question');
    expect(userText).not.toContain('<system_reminder>');
  });

  describe('intuition wiring', () => {
    /**
     * Build a Venice mock that handles BOTH the conscious chat-loop
     * stream (one terminal text round) and the intuition pipeline's
     * 7 completeChat calls (perception, 5 drives, synthesis). The
     * intuition pipeline keys off the system prompt to know which
     * stage it's serving; we mirror the same disambiguation here.
     *
     * Captured ChatRequests on `intuitionCalls` so tests can assert
     * disableThinking landed on every stage and the count matches
     * the expected fan-out.
     */
    function intuitionVenice(intuitionCalls: ChatRequest[]): VeniceClient {
      return {
        async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
          // One terminal round so the chat loop exits cleanly.
          yield { type: 'text', delta: 'ok' };
        },
        async completeChat(req: ChatRequest): Promise<ChatCompletion> {
          intuitionCalls.push(req);
          const sys = req.messages.find((m) => m.role === 'system');
          const sysText = typeof sys?.content === 'string' ? sys.content : '';
          let text = '';
          if (sysText.includes('objective *perception*')) {
            text = 'Classification: chitchat\n\nThe user is saying hi.';
          } else if (sysText.includes('# Your Drive:')) {
            text = 'a drive reaction';
          } else if (sysText.includes('synthesize')) {
            text = 'be warm and brief';
          }
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

    it('fires the pipeline on a cold thread and persists the payload', async () => {
      const intuitionCalls: ChatRequest[] = [];
      const venice = intuitionVenice(intuitionCalls);
      const { svc, mocks } = mockSupabase();
      const updates: unknown[] = [];
      await runChatLoop({
        venice,
        supabase: svc,
        thread: mkThread(),
        userId: 'u-1',
        modelId: 'm',
        history: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        intuitionModelId: 'fake-fast',
        intuitionMood: { band: 2, column: 'confident' },
        handlers: {
          onIntuitionUpdate: (payload) => updates.push(payload),
        },
      });
      // 7 calls = perception + 5 drives + synthesis. Below 7 means
      // the pipeline silently dropped a stage; above 7 means a
      // duplicate fired (the same-round debounce regressed).
      expect(intuitionCalls).toHaveLength(7);
      // disableThinking is the load-bearing knob for GLM-4.7 - see
      // the long-form rationale in src/lib/intuition/pipeline.ts.
      // Locking it in here means any future refactor that strips
      // the flag fails this test instead of silently regressing
      // the live feature into "the icon never shows up".
      for (const req of intuitionCalls) {
        expect(req.disableThinking).toBe(true);
      }
      // The chat-loop fires onIntuitionUpdate exactly once per
      // refresh, with the freshly-computed payload. The handler is
      // how Chat.svelte patches the in-memory thread row so the
      // brain pill and inline card see the new payload without
      // waiting for a Supabase round-trip.
      expect(updates).toHaveLength(1);
      // And the cache write must have been attempted - that's what
      // makes the payload survive a reload.
      expect(mocks.setThreadIntuitionPayload).toHaveBeenCalledTimes(1);
    });

    it('awaits the cache write before notifying the UI handler', async () => {
      // Regression for the "brain icon vanishes mid-modal" bug. The
      // cache write was fire-and-forget; while in flight, any other
      // thread UPDATE (the chat-loop's own update_title call, an
      // unrelated samskara-worker bump, a cross-tab edit) fires a
      // realtime echo whose row.intuition_payload is null. The
      // Chat.svelte rebucketThread handler then overwrites the
      // freshly-patched in-memory payload with that null row, and
      // the icon disappears even though the UI just showed it.
      //
      // Awaiting the write before calling onIntuitionUpdate (and
      // before runChatLoop returns) means by the time any
      // subsequent thread UPDATE fires, the DB row already carries
      // the new payload - so the realtime echo can't strand it.
      // Pinning the order here surfaces a regression to fire-and-
      // forget without depending on a flaky timer-based assertion.
      const completionOrder: string[] = [];
      let resolveWrite!: () => void;
      const writePromise = new Promise<void>((r) => {
        resolveWrite = r;
      });
      const intuitionCalls: ChatRequest[] = [];
      const venice = intuitionVenice(intuitionCalls);
      const { svc } = mockSupabase({
        setThreadIntuitionPayload: vi.fn(async () => {
          await writePromise;
          completionOrder.push('write');
        }),
      });
      const updates: unknown[] = [];
      const runPromise = runChatLoop({
        venice,
        supabase: svc,
        thread: mkThread(),
        userId: 'u-1',
        modelId: 'm',
        history: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        intuitionModelId: 'fake-fast',
        intuitionMood: { band: 2, column: 'confident' },
        handlers: {
          onIntuitionUpdate: () => {
            completionOrder.push('handler');
            updates.push(null);
          },
        },
      });
      // Yield several microtasks so the pipeline reaches the awaited
      // write and parks there. Without the await, the handler would
      // already have been called and 'handler' would be ahead of
      // 'write' in completionOrder.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(completionOrder).toEqual([]);
      expect(updates).toHaveLength(0);
      // Release the write. Now the handler should fire, and only
      // then runChatLoop should resolve.
      resolveWrite();
      await runPromise;
      expect(completionOrder).toEqual(['write', 'handler']);
      expect(updates).toHaveLength(1);
    });

    it('skips the pipeline entirely when intuitionModelId is omitted', async () => {
      // Older callers / tests that don't pass intuitionModelId run
      // the chat loop without the intuition layer. The cache must
      // be left untouched, no completeChat calls fire, and
      // onIntuitionUpdate never invokes - identical pre-feature
      // behaviour.
      const intuitionCalls: ChatRequest[] = [];
      const venice = intuitionVenice(intuitionCalls);
      const { svc, mocks } = mockSupabase();
      const updates: unknown[] = [];
      await runChatLoop({
        venice,
        supabase: svc,
        thread: mkThread(),
        userId: 'u-1',
        modelId: 'm',
        history: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        // intuitionModelId deliberately omitted.
        handlers: {
          onIntuitionUpdate: (payload) => updates.push(payload),
        },
      });
      expect(intuitionCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(mocks.setThreadIntuitionPayload).not.toHaveBeenCalled();
    });
  });

  describe('context-recall wiring', () => {
    /**
     * Build a Venice that handles BOTH the conscious chat-loop's
     * streamChat (one terminal text round, optionally with a tool call
     * the test asks for) and the recall agents' completeChat calls.
     * The intuition pipeline is NOT exercised here - these tests
     * deliberately leave intuitionModelId unset so we can assert the
     * context-recall path in isolation. The intuition + context-recall
     * parallel test below uses a richer mock that handles both.
     *
     * Disambiguation by message content: each recall agent appends its
     * own prompt as the final user turn. Memory-recall mentions
     * `memory_search`; conversation-recall mentions `conversation_search`;
     * wiki-recall mentions `wiki_search`; journal-recall mentions
     * `journal_search`. The mock keys off those tokens to know which
     * agent is asking. Notes default to null (empty signal) for any
     * layer the caller doesn't override.
     */
    interface RecallVeniceNotes {
      memory?: string | null;
      conversation?: string | null;
      wiki?: string | null;
      journal?: string | null;
    }
    function recallVenice(
      recallCalls: ChatRequest[],
      notes: RecallVeniceNotes = {},
      streamRound: StreamEvent[] = [{ type: 'text', delta: 'ok' }]
    ): VeniceClient {
      const memoryNote = notes.memory ?? null;
      const conversationNote = notes.conversation ?? null;
      const wikiNote = notes.wiki ?? null;
      const journalNote = notes.journal ?? null;
      return {
        async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
          for (const ev of streamRound) yield ev;
        },
        async completeChat(req: ChatRequest): Promise<ChatCompletion> {
          recallCalls.push(req);
          const lastUser = [...req.messages]
            .reverse()
            .find((m) => m.role === 'user');
          const content =
            typeof lastUser?.content === 'string' ? lastUser.content : '';
          const pick = (n: string | null): string =>
            n === null
              ? '{"kind":"none"}'
              : `{"kind":"note","note":${JSON.stringify(n)}}`;
          let text = '';
          if (content.includes('memory_search')) {
            text = pick(memoryNote);
          } else if (content.includes('conversation_search')) {
            text = pick(conversationNote);
          } else if (content.includes('wiki_search')) {
            text = pick(wikiNote);
          } else if (content.includes('journal_search')) {
            text = pick(journalNote);
          }
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

    function userRow(content: string): Message {
      return {
        id: 'm-1',
        thread_id: 't-1',
        role: 'user',
        content,
        created_at: 'now',
      };
    }

    it('fires the pipeline on a cold thread, persists, calls handler, injects <think>', async () => {
      const recallCalls: ChatRequest[] = [];
      const venice = recallVenice(recallCalls, {
        memory: 'I remember the user is past the basics on Haskell.',
        conversation: 'we landed on monad transformers last time.',
        // Wiki and journal stay silent (default null) so the stitched
        // note here is just the two-layer memory + conversation case.
      });
      const { svc, mocks } = mockSupabase({
        // Both recall agents call listMessages; return one user turn so
        // they reach the Venice round rather than short-circuiting.
        listMessages: vi.fn(async () => [userRow('hi')]),
      });
      const updates: unknown[] = [];
      const seenStreamRequests: ChatRequest[] = [];
      // Capture the final streamChat request shape to assert the
      // synthetic <think> block landed in history before the round.
      const wrappedVenice: VeniceClient = {
        ...venice,
        async *streamChat(req: ChatRequest) {
          seenStreamRequests.push(req);
          yield { type: 'text', delta: 'ok' } as StreamEvent;
        },
      } as unknown as VeniceClient;
      await runChatLoop({
        venice: wrappedVenice,
        supabase: svc,
        thread: mkThread(),
        userId: 'u-1',
        modelId: 'm',
        history: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        contextRecallEnabled: true,
        intuitionMood: { band: 2, column: 'confident' },
        handlers: {
          onContextRecallUpdate: (payload) => updates.push(payload),
        },
      });
      // Four completeChat calls = one per child agent (all four single-
      // round settle since the agents don't issue tool calls in this
      // test). Pipeline fans out memory, conversation, wiki, journal
      // in parallel.
      expect(recallCalls).toHaveLength(4);
      // The chat-loop fires onContextRecallUpdate exactly once per
      // refresh, with the freshly-computed payload.
      expect(updates).toHaveLength(1);
      // And the cache write must have been attempted - that's what
      // makes the payload survive a reload.
      expect(mocks.setThreadContextRecallPayload).toHaveBeenCalledTimes(1);
      const persistedArg = mocks.setThreadContextRecallPayload.mock.calls[0][1];
      expect(persistedArg).toMatchObject({
        v: 1,
        trigger: 'cold',
        computed_at_round: 1,
        // Stitched note: memory-side, hinge phrase, conversation-side.
        note: 'I remember the user is past the basics on Haskell. From earlier conversations, we landed on monad transformers last time.',
      });
      // The synthetic <think> block must have landed in the streamChat
      // history. Find an assistant message whose content contains the
      // marker.
      const streamReq = seenStreamRequests[0];
      const synthetic = streamReq.messages.find(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.includes('<!-- context-recall-think -->')
      );
      expect(synthetic).toBeDefined();
      expect(synthetic?.content).toContain(
        'we landed on monad transformers last time.'
      );
    });

    it('skips the pipeline entirely when contextRecallEnabled is omitted', async () => {
      // Older callers / tests that don't pass contextRecallEnabled run
      // the chat loop without the context-recall layer. The cache must
      // be left untouched, no completeChat calls fire, and
      // onContextRecallUpdate never invokes - identical pre-feature
      // behaviour.
      const recallCalls: ChatRequest[] = [];
      const venice = recallVenice(recallCalls, { memory: 'A', conversation: 'B' });
      const { svc, mocks } = mockSupabase({
        listMessages: vi.fn(async () => [userRow('hi')]),
      });
      const updates: unknown[] = [];
      await runChatLoop({
        venice,
        supabase: svc,
        thread: mkThread(),
        userId: 'u-1',
        modelId: 'm',
        history: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        // contextRecallEnabled deliberately omitted.
        handlers: {
          onContextRecallUpdate: (payload) => updates.push(payload),
        },
      });
      expect(recallCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(mocks.setThreadContextRecallPayload).not.toHaveBeenCalled();
    });

    it('caches the empty-note negative result without injecting a <think> block', async () => {
      // When both children return the empty signal, the pipeline still
      // writes the cache (with note: '') so the same-round debounce
      // can hold on subsequent triggers - but it must NOT push an
      // empty <think> block onto history. Empty injection would just
      // burn tokens.
      const recallCalls: ChatRequest[] = [];
      const venice = recallVenice(recallCalls, {});
      const { svc, mocks } = mockSupabase({
        listMessages: vi.fn(async () => [userRow('hi')]),
      });
      const seenStreamRequests: ChatRequest[] = [];
      const wrappedVenice: VeniceClient = {
        ...venice,
        async *streamChat(req: ChatRequest) {
          seenStreamRequests.push(req);
          yield { type: 'text', delta: 'ok' } as StreamEvent;
        },
      } as unknown as VeniceClient;
      await runChatLoop({
        venice: wrappedVenice,
        supabase: svc,
        thread: mkThread(),
        userId: 'u-1',
        modelId: 'm',
        history: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        contextRecallEnabled: true,
      });
      expect(recallCalls).toHaveLength(4); // all four children ran
      expect(mocks.setThreadContextRecallPayload).toHaveBeenCalledTimes(1);
      const persistedArg = mocks.setThreadContextRecallPayload.mock.calls[0][1];
      expect(persistedArg).toMatchObject({ v: 1, note: '' });
      // No synthetic <think> block in history.
      const streamReq = seenStreamRequests[0];
      const synthetic = streamReq.messages.find(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.includes('<!-- context-recall-think -->')
      );
      expect(synthetic).toBeUndefined();
    });

    it('runs both subconscious-priming pipelines in parallel on cold start', async () => {
      // The latency win of the parallel design only earns its keep when
      // both pipelines are active and the chat-loop fires them with
      // Promise.all. A serial implementation would still pass the
      // call-count assertion below; we add a per-call timestamp record
      // so the test fails if intuition's 7 calls all land before any
      // recall call (or vice versa).
      const allCalls: { sys: string; lastUser: string; at: number }[] = [];
      // Gate the LAST recall call so the recall side resolves last.
      // If the chat-loop runs the two pipelines serially, the slow
      // gate would block the fast one too and the test would deadlock
      // (the gate is released by an intuition call that only fires
      // when intuition starts, which a serial impl wouldn't do until
      // recall finished).
      let resolveRecallGate!: () => void;
      const recallGate = new Promise<void>((r) => {
        resolveRecallGate = r;
      });
      const venice: VeniceClient = {
        async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
          yield { type: 'text', delta: 'ok' };
        },
        async completeChat(req: ChatRequest): Promise<ChatCompletion> {
          const sys = req.messages.find((m) => m.role === 'system');
          const sysText = typeof sys?.content === 'string' ? sys.content : '';
          const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
          const lastUserText =
            typeof lastUser?.content === 'string' ? lastUser.content : '';
          allCalls.push({ sys: sysText, lastUser: lastUserText, at: Date.now() });
          // Intuition perception fires very early in its pipeline -
          // use it as the gate-release signal so recall can proceed.
          // A serial impl would never reach this point because recall
          // would still be waiting on its own gate.
          if (sysText.includes('objective *perception*')) {
            queueMicrotask(() => resolveRecallGate());
            return {
              text: 'Classification: chitchat\n\nThe user is saying hi.',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (sysText.includes('# Your Drive:')) {
            return {
              text: 'a drive reaction',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (sysText.includes('synthesize')) {
            return {
              text: 'be warm and brief',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (lastUserText.includes('memory_search')) {
            await recallGate;
            return {
              text: '{"kind":"note","note":"recall fact."}',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (lastUserText.includes('conversation_search')) {
            await recallGate;
            return {
              text: '{"kind":"note","note":"recall convo."}',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          // The wiki and journal recall agents also gate on the same
          // perception-released signal. We don't need notes from them
          // for the assertions below; the empty signal is fine. They
          // exist so the test correctly captures the four-way fan-out
          // the pipeline now performs.
          if (lastUserText.includes('wiki_search')) {
            await recallGate;
            return {
              text: '{"kind":"none"}',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (lastUserText.includes('journal_search')) {
            await recallGate;
            return {
              text: '{"kind":"none"}',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          return {
            text: '',
            reasoning: '',
            toolCalls: [],
            usage: null,
            citations: [],
            finishReason: 'stop',
          };
        },
      } as unknown as VeniceClient;
      const { svc, mocks } = mockSupabase({
        listMessages: vi.fn(async () => [userRow('hi')]),
      });
      await runChatLoop({
        venice,
        supabase: svc,
        thread: mkThread(),
        userId: 'u-1',
        modelId: 'm',
        history: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        intuitionModelId: 'fake-fast',
        intuitionMood: { band: 2, column: 'confident' },
        contextRecallEnabled: true,
      });
      // Both caches written.
      expect(mocks.setThreadIntuitionPayload).toHaveBeenCalledTimes(1);
      expect(mocks.setThreadContextRecallPayload).toHaveBeenCalledTimes(1);
      // Total calls = 7 intuition + 4 recall agents (memory,
      // conversation, wiki, journal).
      expect(allCalls.length).toBe(11);
      // The four recall calls were gated on an intuition-side event -
      // if the chat-loop had run intuition first and recall second
      // (serial), the gate-release would have happened during the
      // intuition phase, AFTER recall would have already settled.
      // The recall calls landing AFTER perception (the gate releaser)
      // started is what proves they were running concurrently.
      const perceptionAt = allCalls.find((c) =>
        c.sys.includes('objective *perception*')
      )?.at;
      const recallTimes = allCalls
        .filter(
          (c) =>
            c.lastUser.includes('memory_search') ||
            c.lastUser.includes('conversation_search') ||
            c.lastUser.includes('wiki_search') ||
            c.lastUser.includes('journal_search')
        )
        .map((c) => c.at);
      expect(perceptionAt).toBeDefined();
      // Four-way fan-out: memory + conversation + wiki + journal.
      expect(recallTimes.length).toBe(4);
      for (const t of recallTimes) {
        expect(t).toBeGreaterThanOrEqual(perceptionAt!);
      }
    });

    it('replaces both <think> blocks on a mid-turn title trigger', async () => {
      // Setup: a WARM thread with both caches populated from a prior
      // round (computed_at_round = 1), and history carrying enough
      // user turns that currentUserRound = 2. With matching mood and
      // a non-tripped stale fuse, the pre-round trigger debounces
      // (the cache exists, mood unchanged, fuse not tripped) but the
      // title trigger fires after update_title lands. The mid-turn
      // refresh writes round-2 payloads and replaces the prior
      // synthetic <think> blocks rather than appending.
      const allCalls: ChatRequest[] = [];
      const seenStreamRequests: ChatRequest[] = [];
      let recallCallCount = 0;
      const venice: VeniceClient = {
        async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
          seenStreamRequests.push(req);
          // Round 1 fires update_title, round 2 settles.
          if (seenStreamRequests.length === 1) {
            yield {
              type: 'tool_call',
              toolCall: mkCall('update_title', { title: 'New topic', activity: 'renaming' }),
            } as StreamEvent;
          } else {
            yield { type: 'text', delta: 'final' } as StreamEvent;
          }
        },
        async completeChat(req: ChatRequest): Promise<ChatCompletion> {
          allCalls.push(req);
          const sys = req.messages.find((m) => m.role === 'system');
          const sysText = typeof sys?.content === 'string' ? sys.content : '';
          const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
          const lastUserText =
            typeof lastUser?.content === 'string' ? lastUser.content : '';
          if (sysText.includes('objective *perception*')) {
            return {
              text: 'Classification: chitchat\n\nA topic.',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (sysText.includes('# Your Drive:')) {
            return {
              text: 'react',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (sysText.includes('synthesize')) {
            return {
              text: 'be brief',
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (lastUserText.includes('memory_search')) {
            recallCallCount++;
            return {
              text: `{"kind":"note","note":"memory-${recallCallCount}"}`,
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          if (lastUserText.includes('conversation_search')) {
            recallCallCount++;
            return {
              text: `{"kind":"note","note":"convo-${recallCallCount}"}`,
              reasoning: '',
              toolCalls: [],
              usage: null,
              citations: [],
              finishReason: 'stop',
            };
          }
          return {
            text: '',
            reasoning: '',
            toolCalls: [],
            usage: null,
            citations: [],
            finishReason: 'stop',
          };
        },
      } as unknown as VeniceClient;
      const { svc, mocks } = mockSupabase({
        listMessages: vi.fn(async () => [userRow('hi')]),
      });
      const intuitionUpdates: unknown[] = [];
      const recallUpdates: unknown[] = [];
      const warmIntuition = {
        v: 1 as const,
        perception:
          'Classification: chitchat\n\nThe user is making small talk.',
        drives: {},
        synthesis: 'WARM SYNTHESIS',
        computed_at_round: 1,
        computed_at_band: 2,
        computed_at_column: 'confident' as const,
        computed_at_at: 1_700_000_000_000,
        trigger: 'cold' as const,
      };
      const warmRecall = {
        v: 1 as const,
        note: 'WARM RECALL NOTE',
        computed_at_round: 1,
        computed_at_band: 2,
        computed_at_column: 'confident' as const,
        computed_at_at: 1_700_000_000_000,
        trigger: 'cold' as const,
      };
      await runChatLoop({
        venice,
        supabase: svc,
        thread: mkThread({
          intuition_payload: warmIntuition,
          context_recall_payload: warmRecall,
        }),
        userId: 'u-1',
        modelId: 'm',
        // Two user turns -> currentUserRound = 2. The cached payloads
        // were written at round 1 with matching mood, so the pre-round
        // trigger debounces (mood unchanged, stale fuse not tripped).
        history: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'a reply' },
          { role: 'user', content: 'now a topic shift' },
        ],
        signal: new AbortController().signal,
        intuitionModelId: 'fake-fast',
        intuitionMood: { band: 2, column: 'confident' },
        contextRecallEnabled: true,
        handlers: {
          onIntuitionUpdate: (p) => intuitionUpdates.push(p),
          onContextRecallUpdate: (p) => recallUpdates.push(p),
        },
      });
      // Pre-round debounced; only the title trigger fires. Each
      // pipeline emits exactly one update for the title-triggered
      // refresh.
      expect(intuitionUpdates).toHaveLength(1);
      expect(recallUpdates).toHaveLength(1);
      expect(mocks.setThreadIntuitionPayload).toHaveBeenCalledTimes(1);
      expect(mocks.setThreadContextRecallPayload).toHaveBeenCalledTimes(1);
      // The persisted intuition payload's trigger must be 'title' -
      // proves the refresh came from the mid-turn site, not a stale-
      // fuse fall-through.
      expect(mocks.setThreadIntuitionPayload.mock.calls[0][1]).toMatchObject({
        trigger: 'title',
        computed_at_round: 2,
      });
      expect(
        mocks.setThreadContextRecallPayload.mock.calls[0][1]
      ).toMatchObject({
        trigger: 'title',
        computed_at_round: 2,
      });
      // The second streamChat round must see EXACTLY ONE synthetic
      // intuition <think> block (replaced, not appended) and EXACTLY
      // ONE context-recall <think> block. Anything more means the
      // refresh appended instead of replacing.
      expect(seenStreamRequests).toHaveLength(2);
      const round2Messages = seenStreamRequests[1].messages;
      const intuitionThinkBlocks = round2Messages.filter(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.includes('<!-- intuition-think -->')
      );
      const recallThinkBlocks = round2Messages.filter(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.includes('<!-- context-recall-think -->')
      );
      expect(intuitionThinkBlocks).toHaveLength(1);
      expect(recallThinkBlocks).toHaveLength(1);
      // The blocks in round 2 must carry the FRESH content, not the
      // warm-cache content from before the title trigger.
      const intuitionContent = intuitionThinkBlocks[0].content as string;
      const recallContent = recallThinkBlocks[0].content as string;
      expect(intuitionContent).not.toContain('WARM SYNTHESIS');
      expect(recallContent).not.toContain('WARM RECALL NOTE');
      // Refreshed recall content matches one of the new memory-N /
      // convo-N tokens the mock minted on call 1 and 2.
      expect(recallContent).toMatch(/(memory|convo)-[12]/);
    });
  });
});
