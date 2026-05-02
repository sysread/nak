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
} from '../src/lib/chat-loop';
import type { ChatRequest, StreamEvent, Citation } from '../src/lib/venice';
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
    ...overrides,
  };
  return { svc: mocks as unknown as SupabaseService, mocks, messagesOut };
}

/**
 * Build a VeniceClient whose streamChat yields the configured events for
 * round N on its Nth invocation. Used to script a multi-round
 * conversation. `sleepBetween` inserts an awaited microtask between
 * events so concurrency can be observed in tests.
 */
function mockVenice(roundEvents: StreamEvent[][]): VeniceClient {
  let i = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent, void, void> {
      const events = roundEvents[i++] ?? [];
      for (const ev of events) {
        // Yield on a microtask so the consuming loop's state updates
        // interleave with delta emission — closer to real streaming.
        await Promise.resolve();
        yield ev;
      }
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
    const m: Message = {
      id: 'a',
      thread_id: 't',
      role: 'tool',
      content: '{"ok":true}',
      created_at: 't',
      tool_call_id: 'call_x',
      name: 'memory_search',
    };
    expect(toVeniceMessage(m)).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call_x',
      name: 'memory_search',
    });
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

  it('appends the emphasis-markdown blurb to the system prompt when emphasisMarkdown=true', async () => {
    // When the user has the "Emphasis markdown" toggle on, chat-loop
    // folds a short formatting instruction into the per-turn system-
    // prompt appendix. The blurb tells the model to sprinkle light
    // Markdown emphasis through its reply so long answers skim
    // better. We assert on a distinctive phrase from the blurb so a
    // later wording tweak surfaces here and gets a deliberate review
    // rather than silently changing user-visible model behaviour.
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
    const sys = seenRequests[0].messages[0];
    expect(sys.role).toBe('system');
    expect(typeof sys.content).toBe('string');
    expect(sys.content as string).toContain('scan-points');
  });

  it('omits the emphasis-markdown blurb when the flag is false or absent', async () => {
    // Opt-in: the baseline prompt stays free of the formatting nudge
    // for users who haven't turned it on. Two sub-cases both matter -
    // explicit false (user flipped it off) and absent (older caller
    // or test that predates the option).
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
      expect(req.messages[0].role).toBe('system');
      expect(req.messages[0].content as string).not.toContain('scan-points');
    }
  });

  it('renders the User profile block when userName / userLocation is set', async () => {
    // The profile fields ride along with every reply this account
    // sends, in a "User profile" block at the top of the per-turn
    // appendix. Both values are passed through verbatim - the
    // chat-loop treats them as free-form prose, not a schema.
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
    const sys = seenRequests[0].messages[0];
    expect(sys.role).toBe('system');
    expect(typeof sys.content).toBe('string');
    const content = sys.content as string;
    expect(content).toContain('## User profile');
    expect(content).toContain('Name: Ada');
    expect(content).toContain('Location: Lisbon');
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
    const content = seenRequests[0].messages[0].content as string;
    expect(content).toContain('## User profile');
    expect(content).toContain('Name: Ada');
    expect(content).not.toContain('Location:');
  });

  it('omits the User profile block when both fields are blank or absent', async () => {
    // Fresh-account / opted-out path. Both empty strings and an
    // outright omission of the option keys must skip the block so
    // the baseline prompt stays free of an empty header.
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
      expect(req.messages[0].content as string).not.toContain('## User profile');
    }
  });

  it('wraps the last user message in <user_message> tags when web search is active', async () => {
    // Venice's server-side web search inlines the search payload plus
    // its own framing ("you can use this real time information to
    // answer the user's query above") into what arrives as the user's
    // turn, before the model ever sees it. Without a structural
    // boundary the model misreads the Venice injection as a user
    // instruction — observed live on the "Web Tool Test Request"
    // thread. chat-loop.ts wraps the current user turn in
    // <user_message>...</user_message> to give the model an
    // unambiguous "here is where the human's words end" signal; the
    // system prompt's attribution warning ties the tags back to the
    // non-user origin.
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
    // System message rides first; the two user turns follow, only the
    // most recent of which should be wrapped. An older user turn that
    // Venice already processed on its own round doesn't need re-tagging
    // and tagging it would just bloat the wire.
    expect(msgs[0].role).toBe('system');
    const users = msgs.filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[0].content).toBe('older turn');
    // The current turn ships with a `<datetime>` tag prepended outside
    // the user_message fence (see buildDatetimeTag in chat-loop). The
    // exact tag content is wall-clock-dependent so we match the shape
    // and assert the user_message wrapping is intact around the user's
    // actual words.
    expect(users[1].content).toMatch(
      /^<datetime local="[^"]+" utc="[^"]+" zone="[^"]+" \/>\n<user_message>look up X<\/user_message>$/,
    );
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

  it('wraps the last user message unconditionally', async () => {
    // Wrapping is unconditional because `enable_web_scraping` is
    // always on in venice.ts — any user message that contains a URL
    // gets the full scraped page inlined regardless of web-search
    // state. The <user_message> boundary gives the model a single
    // invariant for telling its own words from platform-injected
    // reference material.
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
    const users = seenRequests[0].messages.filter((m) => m.role === 'user');
    expect(users[0].content).toMatch(
      /^<datetime local="[^"]+" utc="[^"]+" zone="[^"]+" \/>\n<user_message>hi<\/user_message>$/,
    );
  });

  it('does not mutate the caller-supplied history when wrapping', async () => {
    // The loop rebuilds requestMessages every round, so wrapping has
    // to be a projection over a fresh array, not an in-place edit of
    // the caller's VeniceMessage objects. If we mutated, a second
    // runChatLoop invocation — or the caller reusing the history
    // array — would see the tags already baked in and double-wrap.
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

  it('wraps multimodal user content by bracketing the ContentPart array', async () => {
    // Vision-capable user turns ride as `[{type:'text',text:'...'},
    // {type:'image_url', image_url:{url:'...'}}]`. The boundary tags
    // need to enclose *everything* the user actually sent — including
    // images and any extracted-text prelude blocks — so the whole
    // user-authored payload sits inside the <user_message> fence.
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
    const parts = userMsg!.content as Array<{ type: string; text?: string }>;
    // The opening text part fuses the per-turn `<datetime>` tag with
    // the `<user_message>` open tag (the datetime sits outside the
    // boundary, the open tag opens the boundary). Match the shape
    // rather than exact contents - the datetime is wall-clock dependent.
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toMatch(
      /^<datetime local="[^"]+" utc="[^"]+" zone="[^"]+" \/>\n<user_message>$/,
    );
    expect(parts[parts.length - 1]).toEqual({
      type: 'text',
      text: '</user_message>',
    });
    // Original parts sit between the opening and closing tag parts.
    expect(parts).toHaveLength(4);
    expect(parts[1]).toEqual({ type: 'text', text: 'what is in this image?' });
  });

  it('prepends a <datetime> tag with local + utc + zone outside the user_message fence', async () => {
    // The model has no clock without an injected timestamp - asked
    // "what year is it?" it would either refuse or hallucinate from
    // training-cutoff knowledge. The chat-loop builds a `<datetime>`
    // tag every round and prepends it to the latest user turn,
    // outside the `<user_message>` boundary so the system prompt's
    // boundary contract treats it as platform-injected metadata
    // rather than user input.
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
    const userMsg = seenRequests[0].messages.find((m) => m.role === 'user');
    const content = userMsg?.content as string;
    // ISO 8601 local with offset (e.g. '2026-04-24T15:30:00-07:00' or
    // '2026-04-24T15:30:00-08:00' depending on DST), UTC Z form, and
    // the IANA zone name verbatim.
    expect(content).toMatch(
      /^<datetime local="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}" utc="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z" zone="America\/Los_Angeles" \/>\n<user_message>what time is it\?<\/user_message>$/,
    );
  });

  it('uses UTC zone in the datetime tag when journalTimezone is null', async () => {
    // No configured timezone falls back to the runtime's reported
    // zone; in the Vitest environment that's typically UTC, but the
    // important contract is that `zone` is non-empty and well-formed
    // and `local` includes a parseable ISO offset.
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
    const userMsg = seenRequests[0].messages.find((m) => m.role === 'user');
    const content = userMsg?.content as string;
    const m = /^<datetime local="([^"]+)" utc="([^"]+)" zone="([^"]+)" \/>/.exec(content);
    expect(m).not.toBeNull();
    const [, local, utc, zone] = m!;
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/);
    expect(utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(zone.length).toBeGreaterThan(0);
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
  // Title-rename appendix.
  //
  // The chat loop injects a per-turn note into the system-prompt
  // appendix telling the model when to call the `update_title` tool.
  // Observed failure: on placeholder-title threads the model would
  // often skip the rename for several turns in a row, leaving the
  // drawer labelled "New conversation" despite clear topics being
  // introduced. The tests below pin the behaviour that addresses it:
  //
  //   - Placeholder state fires an imperative "required this turn"
  //     block so the model treats the rename as mandatory.
  //   - A manually-set title suppresses the block entirely (once the
  //     user commits to a title, the model must not clobber it).
  //   - A real, model-set title fires the terse topic-shift note.
  //   - The appendix ends with the title block (closest to the user
  //     turn), where instruction-following is strongest.
  // ---------------------------------------------------------------

  function firstSystemPrompt(seen: ChatRequest[]): string {
    const sys = seen[0].messages.find((m) => m.role === 'system');
    if (!sys || typeof sys.content !== 'string') {
      throw new Error('expected a string system message on the request');
    }
    return sys.content;
  }

  it('injects a required-this-turn title block when the thread is still the placeholder', async () => {
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
    const prompt = firstSystemPrompt(seen);
    expect(prompt).toContain('## Required this turn: title this conversation');
    expect(prompt).toContain('`update_title`');
    expect(prompt).toContain('New conversation');
    // The instruction has to land as mandatory, not as a suggestion -
    // the earlier "before responding, call the tool..." phrasing
    // produced a skip rate high enough that threads routinely stayed
    // on the placeholder for several turns.
    expect(prompt).toContain('This is not optional');
  });

  it('omits the title block entirely when the user has manually named the thread', async () => {
    // title_manually_set=true is the sticky flag commitRename flips
    // in Chat.svelte. Once the user has committed to a title, the
    // chat loop must stop asking the model to rename it - otherwise
    // the model could clobber the user's choice. The `update_title`
    // tool stays in the always-on catalog (no harm; model won't call
    // it without the instruction), but the prompt-level suppression
    // is the real gate.
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
      history: [{ role: 'user', content: 'another question' }],
      signal: new AbortController().signal,
    });
    const prompt = firstSystemPrompt(seen);
    // The per-turn rename directives must be gone - neither the
    // placeholder-case "required this turn" block nor the non-
    // placeholder "call update_title if the topic shifted" line
    // should reach the model on a manually-named thread.
    expect(prompt).not.toContain('Required this turn');
    expect(prompt).not.toContain('meaningfully shifted');
    expect(prompt).not.toContain('Current conversation title');
    // The current title itself must not appear - the model has no
    // business even knowing what it is for the purpose of renaming.
    expect(prompt).not.toContain('Python decorators');
    // The `update_title` tool name still appears in the always-on
    // catalog listing (we leave the tool available; cheap no-op if
    // the model calls it), so don't assert on the bare tool name.
  });

  it('injects the short topic-shift note when the thread already has a model-set title', async () => {
    // Non-placeholder + not-manually-set: a title the model already
    // picked. The appendix keeps a terse one-liner so the model can
    // rename on a real topic shift, but deliberately low-weight - it
    // fires on every turn and we don't want to pay tokens or prompt
    // pressure for what is almost always a no-op.
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
      history: [{ role: 'user', content: 'follow up question' }],
      signal: new AbortController().signal,
    });
    const prompt = firstSystemPrompt(seen);
    expect(prompt).toContain('Python decorators');
    expect(prompt).toContain('update_title');
    expect(prompt).toContain('meaningfully shifted');
    // The "required this turn" block is only for the placeholder
    // case; non-placeholder turns must not carry it.
    expect(prompt).not.toContain('Required this turn');
  });

  it('places the title block at the end of the system prompt so it sits closest to the user turn', async () => {
    // Ordering matters for instruction-following: when the title
    // directive was buried above the samskara Calibration/Fire
    // sections, the model would often gloss over it and answer the
    // user directly. The appendix now ends with the title block so
    // the "required this turn" directive is the last thing the model
    // reads before the user message.
    const seen: ChatRequest[] = [];
    const venice = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
        seen.push(req);
        yield { type: 'text', delta: 'ok' };
      },
    } as unknown as VeniceClient;
    const { svc } = mockSupabase({
      // Return non-empty samskara priming so we can check that the
      // title block comes after it rather than before. The cached
      // row shape is {summary, lastRegenAt}; a recent lastRegenAt
      // keeps getCompoundSummary from filtering the row as stale.
      samskaraGetCompoundSummary: vi.fn(async () => ({
        summary: 'Calibrated prose about the user.',
        lastRegenAt: new Date().toISOString(),
      })),
    });
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ title: 'New conversation', title_manually_set: false }),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    });
    const prompt = firstSystemPrompt(seen);
    const samskaraIdx = prompt.indexOf('Calibrated prose about the user');
    const titleIdx = prompt.indexOf('## Required this turn');
    expect(samskaraIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(samskaraIdx);
  });
});
