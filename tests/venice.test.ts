import { describe, it, expect, vi } from 'vitest';
import { VeniceClient, VeniceError, parseSseFrame } from '../src/lib/venice';

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

  it('forwards webSearch as venice_parameters.enable_web_search', async () => {
    // The Venice-specific knob lands inside `venice_parameters`, not at
    // the top level — mirroring https://docs.venice.ai/api-reference.
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
    expect(body.venice_parameters).toEqual({ enable_web_search: 'auto' });
  });

  it('omits venice_parameters entirely when webSearch is not set', async () => {
    // Tests that don't care about web-search shouldn't carry the field —
    // keeps the request body minimal and lets Venice's server-side
    // default apply.
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
    expect(body).not.toHaveProperty('venice_parameters');
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
