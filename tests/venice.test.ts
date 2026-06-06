import { describe, it, expect, vi } from 'vitest';
import {
  VeniceClient,
  VeniceError,
  cancelStream,
  parseSseFrame,
  parseChatCompletion,
  awaitStreamSettled,
  type StreamEvent,
} from '../src/lib/venice';
import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
  SupabaseClient,
} from '@supabase/supabase-js';

function encoder(): TextEncoder {
  return new TextEncoder();
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = encoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe('parseSseFrame', () => {
  it('extracts content delta from a standard text frame', () => {
    const frame = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
    expect(parseSseFrame(frame)).toEqual({ text: 'hello' });
  });

  it('recognizes [DONE]', () => {
    expect(parseSseFrame('data: [DONE]')).toBe('[DONE]');
  });

  it('ignores comment/heartbeat lines', () => {
    expect(parseSseFrame(': ping\n\n')).toBeNull();
  });

  it('returns null when the choice delta is empty', () => {
    expect(parseSseFrame('data: {"choices":[{"delta":{}}]}')).toBeNull();
  });

  it('extracts a tool-call fragment with id and name', () => {
    const frame =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x",' +
      '"type":"function","function":{"name":"memory_search","arguments":""}}]}}]}';
    // Empty argumentsAppend is dropped at parse time. The assembler
    // initialises argumentsBuf='' and only concatenates non-empty
    // appends, so emitting `argumentsAppend: ''` would be a no-op
    // either way - dropping at the parse layer keeps the shape
    // consistent with continuation frames that omit the field
    // entirely.
    expect(parseSseFrame(frame)).toEqual({
      toolCallFragments: [
        { index: 0, id: 'call_x', name: 'memory_search' },
      ],
    });
  });

  it('extracts a tool-call argument fragment (no id/name on continuation)', () => {
    const frame =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]}}]}';
    expect(parseSseFrame(frame)).toEqual({
      toolCallFragments: [
        { index: 0, argumentsAppend: '{"q":' },
      ],
    });
  });

  it('drops empty-string id and name on continuation fragments (Venice quirk)', () => {
    // Venice on at least deepseek-v4-flash emits continuation fragments
    // with `id: ""` and `function.name: ""` alongside the real
    // `argumentsAppend`. Forwarding the empty strings overwrites the
    // assembler's real id/name (set by the opening fragment), which
    // then gets dropped as "missing id" at flush time. The parser
    // strips empty id/name so the assembler only ever sees real
    // values.
    const frame =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"",' +
      '"function":{"name":"","arguments":"{\\"q\\":1}"}}]}}]}';
    expect(parseSseFrame(frame)).toEqual({
      toolCallFragments: [
        { index: 0, argumentsAppend: '{"q":1}' },
      ],
    });
  });

  it('captures finish_reason', () => {
    const frame = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}';
    expect(parseSseFrame(frame)).toEqual({ finishReason: 'tool_calls' });
  });

  it('captures text + finish_reason in one frame', () => {
    const frame =
      'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}';
    expect(parseSseFrame(frame)).toEqual({ text: '!', finishReason: 'stop' });
  });

  it('extracts the usage epilogue frame (empty choices)', () => {
    const frame =
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}';
    expect(parseSseFrame(frame)).toEqual({
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    });
  });

  it('ignores a malformed usage object (missing a field)', () => {
    // A partial usage block is dropped so downstream callers can treat
    // TokenUsage as a total record. The frame still parses but carries
    // no actionable data, so the parser returns null.
    const frame = 'data: {"choices":[],"usage":{"prompt_tokens":12}}';
    expect(parseSseFrame(frame)).toBeNull();
  });

  it('extracts a reasoning_content delta from choices[].delta', () => {
    // Venice / OpenAI-compat convention: chain-of-thought tokens ride
    // on `delta.reasoning_content`, a sibling of `content`. Parser
    // surfaces them as `reasoning` so the consumer yields distinct
    // events rather than mixing into visible text.
    const frame = 'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}';
    expect(parseSseFrame(frame)).toEqual({ reasoning: 'hmm' });
  });

  it('extracts text and reasoning deltas from the same frame', () => {
    // A mid-stream frame can carry both once the model transitions
    // from thinking to answering. Both must survive parsing — dropping
    // either would leak content across the divide.
    const frame =
      'data: {"choices":[{"delta":{"content":"Hi","reasoning_content":"..."}}]}';
    expect(parseSseFrame(frame)).toEqual({ text: 'Hi', reasoning: '...' });
  });

  it('extracts venice_parameters.web_search_citations at top level', () => {
    // Venice ships the citations list on the first streaming chunk,
    // nested under `venice_parameters`. Each row is normalized to a
    // Citation with a 1-based `index` matching the `^N^` superscripts.
    const frame =
      'data: {"choices":[{"delta":{"content":"ok"}}],' +
      '"venice_parameters":{"web_search_citations":[' +
      '{"title":"A","url":"https://a.example","content":"x","date":"2024"},' +
      '{"url":"https://b.example"}' +
      ']}}';
    expect(parseSseFrame(frame)).toEqual({
      text: 'ok',
      citations: [
        {
          index: 1,
          title: 'A',
          url: 'https://a.example',
          content: 'x',
          date: '2024',
        },
        { index: 2, url: 'https://b.example' },
      ],
    });
  });

  it('drops citation rows with no usable url', () => {
    // A malformed row without `url` is useless — we'd render a dead
    // ref. Better to silently prune than to surface a broken link.
    const frame =
      'data: {"choices":[{"delta":{}}],' +
      '"venice_parameters":{"web_search_citations":[' +
      '{"title":"orphan"},' +
      '{"url":"https://ok.example"}' +
      ']}}';
    const parsed = parseSseFrame(frame);
    expect(parsed).toMatchObject({
      citations: [{ index: 2, url: 'https://ok.example' }],
    });
  });
});

describe('VeniceClient.streamChat', () => {
  it('yields incremental text deltas from SSE frames', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    for await (const ev of client.streamChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (ev.type === 'text') deltas.push(ev.delta);
    }
    expect(deltas.join('')).toBe('Hello');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer k',
    });
  });

  it('handles frames split across TCP chunks', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"con',
      'tent":"Hi"}}]}\n\ndata: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(chunks), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    for await (const ev of client.streamChat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    })) {
      if (ev.type === 'text') deltas.push(ev.delta);
    }
    expect(deltas.join('')).toBe('Hi');
  });

  it('accumulates tool-call argument fragments and emits one call at end', async () => {
    // Mirror of the OpenAI streaming pattern: announce call with id+name
    // + empty arguments, stream argument fragments, finish_reason.
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",' +
        '"type":"function","function":{"name":"memory_search","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"qu"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cats\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const calls: unknown[] = [];
    for await (const ev of client.streamChat({
      model: 'm',
      messages: [],
    })) {
      if (ev.type === 'tool_call') calls.push(ev.toolCall);
    }
    expect(calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'memory_search', arguments: '{"query":"cats"}' },
      },
    ]);
  });

  it('interleaves text and tool-call events from the same stream', async () => {
    // Not a common shape for OpenAI today — usually the model either
    // produces text OR tool calls — but the parser should handle a
    // frame that carries text and then the stream ends with a tool-
    // call announcement, gracefully.
    const frames = [
      'data: {"choices":[{"delta":{"content":"let me check..."}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1",' +
        '"type":"function","function":{"name":"memory_search","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const events: Array<{ type: string; value: unknown }> = [];
    for await (const ev of client.streamChat({ model: 'm', messages: [] })) {
      if (ev.type === 'text') events.push({ type: 'text', value: ev.delta });
      else if (ev.type === 'tool_call') events.push({ type: 'tool_call', value: ev.toolCall });
    }
    expect(events[0]).toEqual({ type: 'text', value: 'let me check...' });
    expect(events[events.length - 1]).toMatchObject({
      type: 'tool_call',
      value: { function: { name: 'memory_search' } },
    });
  });

  it('emits parallel tool calls in index order', async () => {
    // Two calls interleaved across frames.
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0",' +
        '"type":"function","function":{"name":"a","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1",' +
        '"type":"function","function":{"name":"b","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const names: string[] = [];
    for await (const ev of client.streamChat({ model: 'm', messages: [] })) {
      if (ev.type === 'tool_call') names.push(ev.toolCall.function.name);
    }
    expect(names).toEqual(['a', 'b']);
  });

  it('drops a partial tool call that never announced id/name', async () => {
    // If a stream is cut off before the id/name frame, we can't
    // safely execute the partial call — better to drop it than
    // dispatch a malformed request.
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":' +
        '{"arguments":"{\\"x\\":"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const events: unknown[] = [];
    for await (const ev of client.streamChat({ model: 'm', messages: [] })) {
      events.push(ev);
    }
    expect(events).toEqual([]);
  });

  it('sends `tools` in the request body when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'fake',
          description: 'test',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    for await (const _ of client.streamChat({
      model: 'm',
      messages: [],
      tools,
    })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.tools).toEqual(tools);
  });

  it('requests the usage epilogue via stream_options', async () => {
    // Without this flag, Venice / OpenAI-compatible providers only
    // emit usage on non-streaming responses. The per-message
    // context-window indicator depends on having it on every turn.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({ model: 'm', messages: [] })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('yields reasoning events alongside text events', async () => {
    // Reasoning-capable models stream chain-of-thought on
    // `delta.reasoning_content` before visible content starts. Both
    // must reach the consumer as distinct event types so the UI can
    // display them in their own panels.
    const frames = [
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"ing..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const events: Array<{ type: string; value: string }> = [];
    for await (const ev of client.streamChat({ model: 'm', messages: [] })) {
      if (ev.type === 'reasoning') events.push({ type: 'reasoning', value: ev.delta });
      else if (ev.type === 'text') events.push({ type: 'text', value: ev.delta });
    }
    expect(events).toEqual([
      { type: 'reasoning', value: 'think' },
      { type: 'reasoning', value: 'ing...' },
      { type: 'text', value: 'Hi' },
    ]);
  });

  it('yields exactly one citations event even if the list is repeated', async () => {
    // Venice docs say citations ride on the first chunk, but we guard
    // against a provider that re-sends the list by only emitting once
    // — downstream consumers treat the event as authoritative and
    // shouldn't have to dedupe.
    const citations =
      '"venice_parameters":{"web_search_citations":[{"url":"https://a.example"}]}';
    const frames = [
      `data: {"choices":[{"delta":{"content":"A"}}],${citations}}\n\n`,
      `data: {"choices":[{"delta":{"content":"B"}}],${citations}}\n\n`,
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const citationEvents: unknown[] = [];
    for await (const ev of client.streamChat({ model: 'm', messages: [] })) {
      if (ev.type === 'citations') citationEvents.push(ev.citations);
    }
    expect(citationEvents).toHaveLength(1);
    expect(citationEvents[0]).toEqual([{ index: 1, url: 'https://a.example' }]);
  });

  it('emits a trailing usage event when the epilogue frame arrives', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      // OpenAI sends the usage epilogue *after* finish_reason and
      // *before* [DONE]. Make sure the stream loop doesn't
      // short-circuit on finish_reason and miss this frame.
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const events: Array<{ type: string; value: unknown }> = [];
    for await (const ev of client.streamChat({ model: 'm', messages: [] })) {
      if (ev.type === 'text') events.push({ type: 'text', value: ev.delta });
      else if (ev.type === 'usage') events.push({ type: 'usage', value: ev.usage });
    }
    expect(events).toEqual([
      { type: 'text', value: 'ok' },
      {
        type: 'usage',
        value: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    ]);
  });

  it('omits the usage event when the provider skips the epilogue', async () => {
    // Older providers (and tests that don't simulate the epilogue)
    // should silently produce no usage event — the caller then
    // persists `usage: null` and the indicator stays hidden.
    const frames = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(frames), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const types: string[] = [];
    for await (const ev of client.streamChat({ model: 'm', messages: [] })) {
      types.push(ev.type);
    }
    expect(types).toEqual(['text']);
  });

  it('forwards webSearch=on with citations on venice_parameters', async () => {
    // The Venice-specific knobs land inside `venice_parameters`, not at
    // the top level — mirroring https://docs.venice.ai/api-reference.
    // Active modes pair `enable_web_citations: true` (model inserts
    // `^N^` superscripts) with `include_search_results_in_stream: true`
    // (Venice emits the matching citation list in the streaming
    // response; without this the list is non-streaming-only, and the
    // inline superscripts become orphaned references).
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({
      model: 'm',
      messages: [],
      webSearch: 'on',
    })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'on',
      enable_web_citations: true,
      include_search_results_in_stream: true,
    });
  });

  it('pairs citations with auto mode too', async () => {
    // `auto` is still an active search mode — citations remain useful
    // whenever the server actually performs a lookup, and the stream
    // opt-in has to ride along on `auto` as well as `on` for the same
    // reason: without it, the superscripts in the content would point
    // to nothing on any turn that did fetch.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({
      model: 'm',
      messages: [],
      webSearch: 'auto',
    })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'auto',
      enable_web_citations: true,
      include_search_results_in_stream: true,
    });
  });

  it('omits citations when webSearch is explicitly off', async () => {
    // 'off' is an explicit opt-out pin, not a search mode — attaching
    // `enable_web_citations` to an off request is noise, so we leave
    // it off the body entirely.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({
      model: 'm',
      messages: [],
      webSearch: 'off',
    })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'off',
    });
  });

  it('always disables the Venice platform system prompt, even when no other flags are set', async () => {
    // Venice's default platform system prompt stacks on top of ours
    // and drags the voice back toward the generic "helpful assistant"
    // phrasing that `buildSystemPrompt` is specifically pushing away
    // from. We opt out unconditionally on every streamChat call so
    // main chat + all sub-agents (recall, reflection, summary, auto-
    // title) run under Nak's baseline alone.
    //
    // `enable_web_scraping` is NOT in here: it used to be unconditional,
    // but auto-inlining URL content into the user turn confused the
    // model-vs-user boundary (the system prompt had to grow attribution
    // guards just to keep the line legible). URL handling now routes
    // through the `web_search` tool, which sets `webScraping: true` on
    // its own sub-completion when it needs to read a URL the caller
    // passed through.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({ model: 'm', messages: [] })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
    });
  });

  it('sets enable_web_scraping only when the caller opts in via webScraping', async () => {
    // Gating mirrors webSearch / webCitations: the field is forwarded
    // only when the caller asked. Callers that never set it ship a
    // request body that omits the scraping flag entirely so Venice's
    // default ("off when unset") applies.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({
      model: 'm',
      messages: [],
      webScraping: true,
    })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_scraping: true,
    });
  });

  it('forwards reasoningEffort as top-level reasoning_effort', async () => {
    // OpenAI-style reasoning_effort lives at the top level of the
    // /chat/completions body (unlike web-search, which Venice nests
    // under venice_parameters). Venice forwards the knob to the
    // underlying provider verbatim.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({
      model: 'm',
      messages: [],
      reasoningEffort: 'high',
    })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort when the caller does not set it', async () => {
    // Non-reasoning models (and utility call paths like auto-titling)
    // should not pay for thinking time they didn't ask for. Some
    // providers also 400 on an unknown `reasoning_effort` field — keep
    // the body clean unless the feature was explicitly enabled.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({ model: 'm', messages: [] })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('forwards verbosity nested under `text` per the OpenAI spec shape', async () => {
    // `text.verbosity` is not a flat field like reasoning_effort — it
    // nests under a top-level `text` object. If a future refactor
    // accidentally promotes it to a flat key, providers that honor
    // the field would stop applying it while still accepting the
    // request, which is a silent regression. Pin the wire shape.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({
      model: 'm',
      messages: [],
      verbosity: 'high',
    })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toEqual({ verbosity: 'high' });
    expect(body).not.toHaveProperty('verbosity');
  });

  it('omits text.verbosity entirely when the caller does not set it', async () => {
    // Providers that don't recognize text.verbosity silently ignore
    // it, but utility call paths (auto-titling) never set it and
    // shouldn't carry an empty `text: {}` either.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({ model: 'm', messages: [] })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('text');
  });

  it('omits `tools` from the body when the array is empty', async () => {
    // A present-but-empty tools array would confuse some providers —
    // better to elide it entirely.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(sseStream(['data: [DONE]\n\n']), { status: 200 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.streamChat({
      model: 'm',
      messages: [],
      tools: [],
    })) {
      void _;
    }
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('tools');
  });

  it('throws auth error on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad key', { status: 401 }));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of client.streamChat({ model: 'm', messages: [] })) void _;
    }).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('throws rate-limit error on 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of client.streamChat({ model: 'm', messages: [] })) void _;
    }).rejects.toMatchObject({ kind: 'rate_limit', status: 429 });
  });

  it('throws network error on fetch failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of client.streamChat({ model: 'm', messages: [] })) void _;
    }).rejects.toBeInstanceOf(VeniceError);
  });
});


// ---------------------------------------------------------------------------
// Streaming-root transport test scaffolding.
//
// The browser's streaming chat path POSTs to the venice edge function's
// /stream route, gets back an envelope ({channelName, assistantRowId,
// completedSoFar}), and subscribes to a Supabase Realtime Broadcast
// channel for live events. The unit tests below stub both halves of
// that transport - functions.invoke for the envelope POST and channel
// for the Broadcast subscription - so the streamChat / awaitStreamSettled /
// cancelStream paths can be exercised without a real Supabase client.
//
// MockChannel exposes an `emit(event, payload)` helper that fires
// every registered broadcast handler for that event name, matching the
// shape `channel.on('broadcast', { event }, cb)` registers. Tests
// trigger the production code by awaiting subscribe -> then calling
// emit() to simulate the function publishing events from the other
// side of the channel.
// ---------------------------------------------------------------------------

interface MockChannel {
  readonly name: string;
  on(
    type: 'broadcast',
    opts: { event: string },
    cb: (msg: { payload: unknown }) => void,
  ): MockChannel;
  subscribe(cb?: (status: string, err?: Error) => void): MockChannel;
  send(msg: {
    type: 'broadcast';
    event: string;
    payload: unknown;
  }): Promise<RealtimeChannelSendResponse>;
  unsubscribe(): Promise<'ok' | 'error' | 'timed out'>;
  emit(event: string, payload: unknown): void;
  readonly sent: Array<{ event: string; payload: unknown }>;
}

function makeChannel(
  name: string,
  opts: { subscribeStatus?: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' } = {},
): MockChannel {
  const handlers = new Map<string, Array<(msg: { payload: unknown }) => void>>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  const channel: MockChannel = {
    name,
    on(_type, { event }, cb) {
      const arr = handlers.get(event) ?? [];
      arr.push(cb);
      handlers.set(event, arr);
      return channel;
    },
    subscribe(cb) {
      // Defer the status callback to a microtask so the production
      // code's await Promise<void>(...) gets a chance to register the
      // callback before we invoke it.
      queueMicrotask(() => {
        cb?.(opts.subscribeStatus ?? 'SUBSCRIBED');
      });
      return channel;
    },
    async send(msg) {
      sent.push({ event: msg.event, payload: msg.payload });
      return 'ok';
    },
    async unsubscribe() {
      return 'ok';
    },
    emit(event, payload) {
      const arr = handlers.get(event) ?? [];
      for (const cb of arr) cb({ payload });
    },
    sent,
  };
  return channel;
}

interface MockSupabaseOpts {
  envelope?: unknown;
  invokeError?: Error;
  channels?: Map<string, MockChannel>;
}

interface MockSupabase {
  client: SupabaseClient;
  channels: Map<string, MockChannel>;
  invokeCalls: Array<{ name: string; body: unknown }>;
}

function makeSupabase(opts: MockSupabaseOpts = {}): MockSupabase {
  const channels = opts.channels ?? new Map<string, MockChannel>();
  const invokeCalls: Array<{ name: string; body: unknown }> = [];
  const client = {
    functions: {
      invoke: vi.fn(async (name: string, args: { body: unknown }) => {
        invokeCalls.push({ name, body: args.body });
        if (opts.invokeError) {
          return { data: null, error: opts.invokeError };
        }
        return { data: opts.envelope ?? null, error: null };
      }),
    },
    channel: vi.fn((name: string) => {
      const existing = channels.get(name);
      if (existing) return existing as unknown as RealtimeChannel;
      const ch = makeChannel(name);
      channels.set(name, ch);
      return ch as unknown as RealtimeChannel;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  } as unknown as SupabaseClient;
  return { client, channels, invokeCalls };
}

async function collectFirst<T>(
  gen: AsyncGenerator<T, void, void>,
  max = 50,
): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (out.length >= max) break;
  }
  return out;
}

describe('streamChat (streaming-root transport)', () => {
  it('POSTs the envelope to venice/stream with threadId, userMessageId, and the built body', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client, invokeCalls } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: null,
        completedSoFar: '',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const consumer = venice.streamChat({
      model: 'kimi-k2-5',
      messages: [{ role: 'user', content: 'hi' }],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    // Start consuming so the await on functions.invoke fires.
    const drained = collectFirst(consumer);
    // After subscribe completes the consumer is parked on the queue;
    // emit END to wind it down so the test can assert.
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    await drained;

    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].name).toBe('venice/stream');
    const body = invokeCalls[0].body as {
      threadId: string;
      userMessageId: string;
      body: { model: string; messages: unknown[]; stream: boolean };
    };
    expect(body.threadId).toBe('T1');
    expect(body.userMessageId).toBe('U1');
    expect(body.body.model).toBe('kimi-k2-5');
    expect(body.body.stream).toBe(true);
    expect(body.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('translates response_text/reasoning_text/END broadcasts into StreamEvents in order', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: null,
        completedSoFar: '',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const gen = venice.streamChat({
      model: 'm',
      messages: [],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    const collected: StreamEvent[] = [];
    const drained = (async () => {
      for await (const ev of gen) collected.push(ev);
    })();
    // Let subscribe resolve.
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('reasoning_text', { content: 'thinking…' });
    channel.emit('response_text', { content: 'hello ' });
    channel.emit('response_text', { content: 'world' });
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    await drained;
    expect(collected).toEqual([
      { type: 'reasoning', delta: 'thinking…' },
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'world' },
      { type: 'end', persistedAssistantId: 'A1', terminalKind: 'completed', roundsRun: 0 },
    ]);
  });

  it('translates an assistant_round_committed broadcast into a round_committed StreamEvent', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: null,
        completedSoFar: '',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const gen = venice.streamChat({
      model: 'm',
      messages: [],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    const collected: StreamEvent[] = [];
    const drained = (async () => {
      for await (const ev of gen) collected.push(ev);
    })();
    await Promise.resolve();
    await Promise.resolve();
    // A tool-calling round narrates, commits its assistant row (the
    // round boundary), then the terminal round answers. The boundary
    // marker must reach the consumer as a round_committed carrying the
    // persisted row id so the chat-loop can reset its live buffers and
    // hand off to that row's card.
    channel.emit('reasoning_text', { content: 'let me search' });
    channel.emit('assistant_round_committed', { id: 'ROUND0' });
    channel.emit('response_text', { content: 'the answer' });
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    await drained;
    expect(collected).toEqual([
      { type: 'reasoning', delta: 'let me search' },
      { type: 'round_committed', id: 'ROUND0' },
      { type: 'text', delta: 'the answer' },
      { type: 'end', persistedAssistantId: 'A1', terminalKind: 'completed', roundsRun: 0 },
    ]);
  });

  it('drops an assistant_round_committed broadcast carrying no id', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: null,
        completedSoFar: '',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const gen = venice.streamChat({
      model: 'm',
      messages: [],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    const collected: StreamEvent[] = [];
    const drained = (async () => {
      for await (const ev of gen) collected.push(ev);
    })();
    await Promise.resolve();
    await Promise.resolve();
    // A malformed marker with no usable id can't drive a row hand-off;
    // drop it rather than emit a round_committed the consumer would
    // getMessage(undefined) on.
    channel.emit('assistant_round_committed', {});
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    await drained;
    expect(collected).toEqual([
      { type: 'end', persistedAssistantId: 'A1', terminalKind: 'completed', roundsRun: 0 },
    ]);
  });

  it('drops empty-content response_text / reasoning_text broadcasts', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: null,
        completedSoFar: '',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const gen = venice.streamChat({
      model: 'm',
      messages: [],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    const collected: StreamEvent[] = [];
    const drained = (async () => {
      for await (const ev of gen) collected.push(ev);
    })();
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('response_text', { content: '' });
    channel.emit('reasoning_text', { content: '' });
    channel.emit('response_text', { content: 'real' });
    channel.emit('END', {
      persistedAssistantId: 'A',
      terminalKind: 'completed',
    });
    await drained;
    expect(collected).toEqual([
      { type: 'text', delta: 'real' },
      { type: 'end', persistedAssistantId: 'A', terminalKind: 'completed', roundsRun: 0 },
    ]);
  });

  it('yields completedSoFar as a text delta before live events on reconnect', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: 'A1',
        completedSoFar: 'partial answer so far',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const gen = venice.streamChat({
      model: 'm',
      messages: [],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    const collected: StreamEvent[] = [];
    const drained = (async () => {
      for await (const ev of gen) collected.push(ev);
    })();
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('response_text', { content: ' more' });
    channel.emit('END', {
      persistedAssistantId: 'A1',
      terminalKind: 'completed',
    });
    await drained;
    expect(collected).toEqual([
      { type: 'text', delta: 'partial answer so far' },
      { type: 'text', delta: ' more' },
      { type: 'end', persistedAssistantId: 'A1', terminalKind: 'completed', roundsRun: 0 },
    ]);
  });

  it('translates tool_call_request and tool_call_response broadcasts into legacy shapes', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: null,
        completedSoFar: '',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const gen = venice.streamChat({
      model: 'm',
      messages: [],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    const collected: StreamEvent[] = [];
    const drained = (async () => {
      for await (const ev of gen) collected.push(ev);
    })();
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('tool_call_request', {
      request: { id: 'call_abc', name: 'memory_search', args: { q: 'cats' } },
    });
    channel.emit('tool_call_response', {
      id: 'call_abc',
      name: 'memory_search',
      ok: true,
      result_summary: '[3 results]',
    });
    channel.emit('END', {
      persistedAssistantId: 'A',
      terminalKind: 'completed',
    });
    await drained;
    expect(collected).toEqual([
      {
        type: 'tool_call',
        toolCall: {
          id: 'call_abc',
          type: 'function',
          function: { name: 'memory_search', arguments: '{"q":"cats"}' },
        },
      },
      {
        type: 'tool_call_response',
        id: 'call_abc',
        name: 'memory_search',
        ok: true,
        resultSummary: '[3 results]',
      },
      { type: 'end', persistedAssistantId: 'A', terminalKind: 'completed', roundsRun: 0 },
    ]);
  });

  it('drops malformed tool_call_request broadcasts (missing id or name)', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: null,
        completedSoFar: '',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const gen = venice.streamChat({
      model: 'm',
      messages: [],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    const collected: StreamEvent[] = [];
    const drained = (async () => {
      for await (const ev of gen) collected.push(ev);
    })();
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('tool_call_request', { request: { name: 'memory_search', args: {} } });
    channel.emit('tool_call_request', { request: { id: 'x', args: {} } });
    channel.emit('END', {
      persistedAssistantId: 'A',
      terminalKind: 'completed',
    });
    await drained;
    expect(collected).toEqual([
      { type: 'end', persistedAssistantId: 'A', terminalKind: 'completed', roundsRun: 0 },
    ]);
  });

  it('forwards a server END(error) on the channel as the consumer\'s last event', async () => {
    const channel = makeChannel('thread:T1:stream');
    const channels = new Map([[channel.name, channel]]);
    const { client } = makeSupabase({
      envelope: {
        channelName: channel.name,
        assistantRowId: null,
        completedSoFar: '',
      },
      channels,
    });
    const venice = new VeniceClient({ supabase: client });
    const gen = venice.streamChat({
      model: 'm',
      messages: [],
      streamCtx: { threadId: 'T1', userMessageId: 'U1' },
    });
    const collected: StreamEvent[] = [];
    const drained = (async () => {
      for await (const ev of gen) collected.push(ev);
    })();
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('END', {
      persistedAssistantId: '',
      terminalKind: 'error',
      conflict: 'a newer user message landed first',
    });
    await drained;
    expect(collected).toEqual([
      {
        type: 'end',
        persistedAssistantId: '',
        terminalKind: 'error',
        roundsRun: 0,
        conflict: 'a newer user message landed first',
      },
    ]);
  });

  it('throws VeniceError when functions.invoke returns an error', async () => {
    const { client } = makeSupabase({ invokeError: new Error('boom') });
    const venice = new VeniceClient({ supabase: client });
    await expect(async () => {
      for await (const _ of venice.streamChat({
        model: 'm',
        messages: [],
        streamCtx: { threadId: 'T1', userMessageId: 'U1' },
      })) {
        void _;
      }
    }).rejects.toBeInstanceOf(VeniceError);
  });
});

describe('awaitStreamSettled (reconnect poll)', () => {
  // A client whose functions.invoke returns a programmed sequence of
  // {data,error} results, one per call (the last entry repeats).
  function sequencedClient(
    sequence: Array<{ data: unknown; error: Error | null }>,
  ): { client: SupabaseClient; bodies: unknown[]; invoke: ReturnType<typeof vi.fn> } {
    const bodies: unknown[] = [];
    let i = 0;
    const invoke = vi.fn(async (_name: string, args: { body: unknown }) => {
      bodies.push(args.body);
      return sequence[Math.min(i++, sequence.length - 1)];
    });
    const client = { functions: { invoke } } as unknown as SupabaseClient;
    return { client, bodies, invoke };
  }

  const inflight = (completedSoFar: string) => ({
    data: { channelName: 'thread:T1:stream', assistantRowId: 'A1', completedSoFar },
    error: null,
  });
  const settled = {
    data: {
      channelName: 'thread:T1:stream',
      assistantRowId: null,
      completedSoFar: '',
      noStreamInFlight: true,
    },
    error: null,
  };

  it('polls reconnectOnly until noStreamInFlight, surfacing each partial', async () => {
    const { client, bodies, invoke } = sequencedClient([
      inflight('hel'),
      inflight('hello'),
      settled,
    ]);
    const progress: string[] = [];
    await awaitStreamSettled(
      client,
      { threadId: 'T1' },
      { intervalMs: 0, onProgress: (c) => progress.push(c) },
    );
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(bodies[0]).toEqual({ threadId: 'T1', reconnectOnly: true });
    // onProgress fires for the in-flight probes only, not the settle.
    expect(progress).toEqual(['hel', 'hello']);
  });

  it('stops as soon as the signal aborts', async () => {
    const ctl = new AbortController();
    const invoke = vi.fn(async () => {
      // Abort during the first probe; the post-probe aborted-check bails
      // before scheduling another poll.
      ctl.abort();
      return inflight('x');
    });
    const client = { functions: { invoke } } as unknown as SupabaseClient;
    await awaitStreamSettled(
      client,
      { threadId: 'T1' },
      { intervalMs: 50, signal: ctl.signal },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('swallows a transient invoke error and keeps polling', async () => {
    const { client, invoke } = sequencedClient([
      { data: null, error: new Error('network blip') },
      settled,
    ]);
    await awaitStreamSettled(client, { threadId: 'T1' }, { intervalMs: 0 });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('cancelStream', () => {
  it('subscribes the thread control channel and publishes a cancel broadcast', async () => {
    const control = makeChannel('thread:T1:control');
    const channels = new Map([[control.name, control]]);
    const { client } = makeSupabase({ channels });
    await cancelStream(client, 'T1');
    expect(control.sent).toEqual([
      { event: 'cancel', payload: { type: 'cancel' } },
    ]);
  });

  it('swallows the error when the control channel subscribe fails', async () => {
    const control = makeChannel('thread:T1:control', {
      subscribeStatus: 'CHANNEL_ERROR',
    });
    const channels = new Map([[control.name, control]]);
    const { client } = makeSupabase({ channels });
    // Should not throw - the comment on cancelStream documents it as
    // best-effort: a cancel that can't reach the channel becomes a
    // no-op rather than a banner-raising error.
    await expect(cancelStream(client, 'T1')).resolves.toBeUndefined();
    expect(control.sent).toHaveLength(0);
  });
});

describe('parseChatCompletion', () => {
  it('renders missing content as empty string rather than null', () => {
    // The OpenAI shape allows `content: null` when the model produced
    // only tool calls. Callers should be able to read .text without a
    // nullable check.
    const result = parseChatCompletion({
      choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'tool_calls' }],
    });
    expect(result.text).toBe('');
    expect(result.finishReason).toBe('tool_calls');
  });

  it('drops malformed tool_calls without an id or function name', () => {
    // A tool call without an id or name can't be safely executed -
    // OpenAI requires both. Mirror the streaming path's defensive drop.
    const result = parseChatCompletion({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'ok', type: 'function', function: { name: 'spy', arguments: '{}' } },
              { type: 'function', function: { name: 'no-id', arguments: '{}' } },
              { id: 'no-name', type: 'function' },
            ],
          },
        },
      ],
    });
    expect(result.toolCalls).toEqual([
      { id: 'ok', type: 'function', function: { name: 'spy', arguments: '{}' } },
    ]);
  });

  it('drops a partial usage block', () => {
    // Same discipline as the streaming parser: TokenUsage is treated
    // as a total record downstream. A row missing any of the three
    // counters drops to null rather than yielding NaN-prone defaults.
    const result = parseChatCompletion({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 5 },
    });
    expect(result.usage).toBeNull();
  });

  it('throws a parse-kind VeniceError on a non-object payload', () => {
    expect(() => parseChatCompletion(null)).toThrow(VeniceError);
    expect(() => parseChatCompletion('nope')).toThrow(VeniceError);
  });

  it('returns reasoning_content as the reasoning field', () => {
    const result = parseChatCompletion({
      choices: [
        {
          message: {
            content: 'visible',
            reasoning_content: 'hidden chain-of-thought',
          },
        },
      ],
    });
    expect(result.text).toBe('visible');
    expect(result.reasoning).toBe('hidden chain-of-thought');
  });
});

