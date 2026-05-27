import { describe, it, expect, vi } from 'vitest';
import {
  VeniceClient,
  VeniceError,
  parseSseFrame,
  parseChatCompletion,
  USAGE_MAX_PAGES,
} from '../src/lib/venice';

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
    expect(parseSseFrame(frame)).toEqual({
      toolCallFragments: [
        { index: 0, id: 'call_x', name: 'memory_search', argumentsAppend: '' },
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

describe('VeniceClient.completeChat', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('POSTs without stream / stream_options and returns the parsed completion', async () => {
    // Background callers go through completeChat to avoid SSE latency
    // and the stream-only failure modes that bit web_search. The wire
    // body must therefore NOT carry stream=true or stream_options - if
    // those leak in, the provider opens an SSE response and the JSON
    // parse below would throw.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hello world',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.completeChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('hello world');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.reasoning).toBe('');

    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('stream_options');
  });

  it('omits include_search_results_in_stream from venice_parameters even with web search on', async () => {
    // The flag exists only because the streaming endpoint defaults to
    // dropping the citations list - the non-streaming response always
    // carries citations at the top level. Sending the flag on a non-
    // streaming request is harmless but noise; pin its absence so a
    // future refactor doesn't accidentally let it leak across.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.completeChat({
      model: 'm',
      messages: [],
      webSearch: 'on',
    });
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'on',
      enable_web_citations: true,
    });
  });

  it('returns assembled tool_calls when the model emits any', async () => {
    // Non-streaming responses ship tool_calls already assembled on
    // `message.tool_calls` - no fragment-stitching needed. Each entry's
    // `arguments` is a JSON string the caller is expected to parse.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'spy', arguments: '{"x":1}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.completeChat({ model: 'm', messages: [] });
    expect(result.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'spy', arguments: '{"x":1}' },
      },
    ]);
    expect(result.text).toBe('');
    expect(result.finishReason).toBe('tool_calls');
  });

  it('surfaces venice_parameters.web_search_citations on the result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'sourced answer' }, finish_reason: 'stop' }],
        venice_parameters: {
          web_search_citations: [
            { title: 'A', url: 'https://a.example' },
            { url: 'https://b.example' },
          ],
        },
      })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.completeChat({ model: 'm', messages: [] });
    expect(result.citations).toEqual([
      { index: 1, title: 'A', url: 'https://a.example' },
      { index: 2, url: 'https://b.example' },
    ]);
  });

  it('throws auth error on 401', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('bad key', { status: 401 }));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.completeChat({ model: 'm', messages: [] })
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('throws parse error on non-JSON response body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('definitely not json', { status: 200 }));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.completeChat({ model: 'm', messages: [] })
    ).rejects.toMatchObject({ kind: 'parse' });
  });

  it('retries on 429 and succeeds on the next attempt', async () => {
    // Background sub-calls (web_search, research_docs, intuition, etc.)
    // used to lose the whole turn on a transient 429 - the error
    // surfaced as `{error: "Venice rate limit hit (HTTP 429)..."}` on
    // the tool-result row and the main model had to handle it. We now
    // sleep and retry transparently here.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('overloaded', { status: 429 }))
        .mockResolvedValueOnce(
          jsonResponse({
            choices: [
              { message: { content: 'eventually-ok' }, finish_reason: 'stop' },
            ],
          })
        );
      const client = new VeniceClient({
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const promise = client.completeChat({ model: 'm', messages: [] });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.text).toBe('eventually-ok');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors Retry-After before retrying', async () => {
    // When Venice tells us how long to wait, respect that hint rather
    // than the fallback log10 schedule. Pins behavior parity with the
    // streaming retry path in chat-loop.ts.
    vi.useFakeTimers();
    try {
      const rateLimit = new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '7' },
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(rateLimit)
        .mockResolvedValueOnce(
          jsonResponse({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          })
        );
      const client = new VeniceClient({
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const promise = client.completeChat({ model: 'm', messages: [] });
      // Let the first 429 land and the sleep enqueue.
      await vi.advanceTimersByTimeAsync(0);
      // 6s elapsed - retry should still be pending (Retry-After: 7).
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Cross the threshold; retry fires.
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;
      expect(result.text).toBe('ok');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates 429 after exhausting retries', async () => {
    // Five attempts (initial + four retries). A stuck quota surfaces
    // as a rate_limit VeniceError so the caller can decide whether to
    // wrap into a tool-error row or surface to the user.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response('overloaded', { status: 429 }));
      const client = new VeniceClient({
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const promise = client
        .completeChat({ model: 'm', messages: [] })
        .catch((err: unknown) => err);
      await vi.runAllTimersAsync();
      const err = await promise;
      expect(err).toBeInstanceOf(VeniceError);
      expect(err).toMatchObject({ kind: 'rate_limit', status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts during the retry sleep and surfaces an AbortError', async () => {
    // Mirrors the streaming path: a cancel during the rate-limit wait
    // throws a spec-shaped AbortError so existing AbortError branches
    // (tool cancel, send-cancel) fire identically.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response('overloaded', { status: 429 }));
      const client = new VeniceClient({
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const ac = new AbortController();
      const promise = client
        .completeChat({ model: 'm', messages: [], signal: ac.signal })
        .catch((err: unknown) => err);
      // Let the first 429 land and the sleep enqueue.
      await vi.advanceTimersByTimeAsync(0);
      ac.abort();
      await vi.runAllTimersAsync();
      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('AbortError');
      // Only the initial attempt fired; the retry was cancelled mid-sleep.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

describe('VeniceClient.fetchUsage', () => {
  function usagePage(data: unknown[], totalPages = 1): Response {
    return new Response(
      JSON.stringify({
        data,
        pagination: { limit: 500, page: 1, total: data.length, totalPages },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  it('issues a single-page GET with the expected headers and query string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(usagePage([]));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchUsage({
      startDate: '2026-01-01T00:00:00Z',
      endDate: '2026-02-01T00:00:00Z',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/billing/usage?');
    expect(String(url)).toContain('startDate=2026-01-01');
    expect(String(url)).toContain('endDate=2026-02-01');
    expect(String(url)).toContain('sortOrder=desc');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer k',
      Accept: 'application/json',
    });
  });

  it('decodes a well-formed row', async () => {
    const row = {
      timestamp: '2026-03-01T12:00:00Z',
      sku: 'llm-output-mtokens-kimi-k2-5',
      pricePerUnitUsd: 0.002,
      units: 72,
      amount: 0.14,
      currency: 'USD',
      notes: '',
      inferenceDetails: {
        requestId: 'req_1',
        promptTokens: 50_000,
        completionTokens: 22_000,
        inferenceExecutionTime: 1234,
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(usagePage([row]));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rows = await client.fetchUsage();
    expect(rows).toEqual([row]);
  });

  it('drops rows that fail coercion without failing the whole fetch', async () => {
    // Defensive decoder drops any row missing a required scalar. The
    // endpoint is marked beta and shape drift shouldn't crash the
    // Usage pane; surviving rows still come through.
    const good = {
      timestamp: '2026-03-01T12:00:00Z',
      sku: 'grok-41-fast',
      pricePerUnitUsd: 0.001,
      units: 10,
      amount: 0.05,
      currency: 'USD',
      notes: '',
      inferenceDetails: null,
    };
    const bad = { sku: 'broken' }; // no timestamp, no amount
    const fetchImpl = vi.fn().mockResolvedValue(usagePage([bad, good]));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rows = await client.fetchUsage();
    expect(rows).toEqual([good]);
  });

  it('drops rows with an unrecognized currency', async () => {
    const row = {
      timestamp: '2026-03-01T12:00:00Z',
      sku: 'x',
      pricePerUnitUsd: 0,
      units: 1,
      amount: 1,
      currency: 'BTC',
      notes: '',
      inferenceDetails: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(usagePage([row]));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rows = await client.fetchUsage();
    expect(rows).toEqual([]);
  });

  it('pages through every page the server reports', async () => {
    // Two-page response: request 1 returns totalPages=2, request 2
    // returns the second page. fetchUsage should page transparently
    // and concatenate the rows.
    const page1 = {
      timestamp: '2026-03-02T00:00:00Z',
      sku: 'a',
      pricePerUnitUsd: 0,
      units: 1,
      amount: 0.1,
      currency: 'USD' as const,
      notes: '',
      inferenceDetails: null,
    };
    const page2 = { ...page1, timestamp: '2026-03-01T00:00:00Z', sku: 'b' };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(usagePage([page1], 2))
      .mockResolvedValueOnce(usagePage([page2], 2));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rows = await client.fetchUsage();
    expect(rows.map((r) => r.sku)).toEqual(['a', 'b']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url2] = fetchImpl.mock.calls[1];
    expect(String(url2)).toContain('page=2');
  });

  it('throws an auth error on 401', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('bad key', { status: 401 }));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetchUsage()).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
  });

  it('reports per-page progress through onProgress', async () => {
    // Two-page response: the callback must fire once per page with
    // the 1-based page index and the server-reported totalPages so
    // the Usage pane can render a determinate progress bar.
    const row = {
      timestamp: '2026-03-02T00:00:00Z',
      sku: 'a',
      pricePerUnitUsd: 0,
      units: 1,
      amount: 0.1,
      currency: 'USD' as const,
      notes: '',
      inferenceDetails: null,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(usagePage([row], 2))
      .mockResolvedValueOnce(usagePage([row], 2));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ticks: { page: number; totalPages: number }[] = [];
    await client.fetchUsage({ onProgress: (info) => ticks.push(info) });
    expect(ticks).toEqual([
      { page: 1, totalPages: 2 },
      { page: 2, totalPages: 2 },
    ]);
  });

  it('clamps the onProgress totalPages at USAGE_MAX_PAGES and survives a throwing listener', async () => {
    // A pathologically large totalPages must not promise pages the
    // safety cap will never let the loop pull. The callback should
    // read the clamped value so a progress UI never shows a
    // fraction that can't reach 100%. A factory mock (not a single
    // mockResolvedValue) is required here because Response bodies
    // can only be consumed once - the loop will paginate up to the
    // cap and reuse would fail with a parse error.
    const fetchImpl = vi.fn(async () => usagePage([], 9999));
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ticks: { page: number; totalPages: number }[] = [];
    await client.fetchUsage({
      onProgress: (info) => {
        ticks.push(info);
        // A misbehaving UI listener must not abort the paging loop.
        throw new Error('listener throws should not abort paging');
      },
    });
    expect(ticks).toHaveLength(USAGE_MAX_PAGES);
    expect(ticks[0]).toEqual({ page: 1, totalPages: USAGE_MAX_PAGES });
    expect(ticks[ticks.length - 1]).toEqual({
      page: USAGE_MAX_PAGES,
      totalPages: USAGE_MAX_PAGES,
    });
  });
});

describe('generateImage', () => {
  function jsonResponse(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {}
  ): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  it('posts to /image/generate and returns the first image as base64', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ id: 'g1', images: ['BASE64DATA'] })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.generateImage({
      model: 'venice-sd35',
      prompt: 'a cat',
      width: 1024,
      height: 1024,
    });
    expect(result).toEqual({ imageBase64: 'BASE64DATA', mimeType: 'image/webp' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/image/generate');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      model: 'venice-sd35',
      prompt: 'a cat',
      width: 1024,
      height: 1024,
      variants: 1,
      safe_mode: true,
      return_binary: false,
      format: 'webp',
    });
  });

  it('throws on a content-policy violation even with HTTP 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        { id: 'g1', images: [] },
        { headers: { 'x-venice-is-content-violation': 'true' } }
      )
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.generateImage({ model: 'm', prompt: 'x' })
    ).rejects.toBeInstanceOf(VeniceError);
  });

  it('throws when the response carries no image data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ id: 'g1', images: [] })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.generateImage({ model: 'm', prompt: 'x' })
    ).rejects.toThrow(/no image data/);
  });

  it('surfaces an HTTP error through classifyError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429 })
    );
    const client = new VeniceClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.generateImage({ model: 'm', prompt: 'x' })
    ).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});
