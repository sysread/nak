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
import { runChatLoop, MAX_ROUNDS, toVeniceMessage } from '../src/lib/chat-loop';
import type { ChatRequest, StreamEvent, Citation } from '../src/lib/venice';
import type { VeniceClient } from '../src/lib/venice';
import type { SupabaseService, Thread, Message } from '../src/lib/supabase';
import type { OpenAIToolCall } from '../src/lib/tools';

function mkThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't-1',
    user_id: 'u-1',
    title: 'Test',
    model: null,
    reasoning_effort: null,
    verbosity: null,
    tools_enabled: false,
    archived: false,
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
  setThreadToolsEnabled: ReturnType<typeof vi.fn>;
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
    setThreadToolsEnabled: vi.fn(async () => undefined),
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
    expect(users[1].content).toBe('<user_message>look up X</user_message>');
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
    expect(users[0].content).toBe('<user_message>hi</user_message>');
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
    expect(parts[0]).toEqual({ type: 'text', text: '<user_message>' });
    expect(parts[parts.length - 1]).toEqual({
      type: 'text',
      text: '</user_message>',
    });
    // Original parts sit between the opening and closing tag parts.
    expect(parts).toHaveLength(4);
    expect(parts[1]).toEqual({ type: 'text', text: 'what is in this image?' });
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
    const citationUpdates: Citation[][] = [];
    await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread({ tools_enabled: false }),
      userId: 'u-1',
      modelId: 'm',
      history: [{ role: 'user', content: 'what is btc at' }],
      signal: new AbortController().signal,
      handlers: {
        onCitationsUpdate: (cites) => citationUpdates.push(cites),
      },
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
    // Handler fired during the tool round, before the terminal
    // assistant was persisted.
    expect(citationUpdates.length).toBeGreaterThanOrEqual(1);
    expect(citationUpdates[citationUpdates.length - 1]).toHaveLength(1);
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
      thread: mkThread({ tools_enabled: false }),
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
      thread: mkThread({ tools_enabled: true }),
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
      thread: mkThread({ tools_enabled: true }),
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

  it('flips tools_enabled when the model calls toggle_tools', async () => {
    const venice = mockVenice([
      [{ type: 'tool_call', toolCall: mkCall('toggle_tools', { enable: true }) }],
      [{ type: 'text', delta: 'Tools are ready.' }],
    ]);
    const { svc, mocks } = mockSupabase();
    const changes: boolean[] = [];
    const result = await runChatLoop({
      venice,
      supabase: svc,
      thread: mkThread(),
      userId: 'u-1',
      modelId: 'm',
      history: [],
      signal: new AbortController().signal,
      handlers: {
        onToolsEnabledChange: (enabled) => changes.push(enabled),
      },
    });
    expect(result.toolsEnabled).toBe(true);
    expect(changes).toEqual([true]);
    expect(mocks.setThreadToolsEnabled).toHaveBeenCalledWith('t-1', true);
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
      thread: mkThread({ tools_enabled: true }),
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
      thread: mkThread({ tools_enabled: true }),
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
      thread: mkThread({ tools_enabled: true }),
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
      thread: mkThread({ tools_enabled: true }),
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
      thread: mkThread({ tools_enabled: true }),
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
});
