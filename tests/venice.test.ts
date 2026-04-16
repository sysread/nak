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
  it('extracts content delta from standard frame', () => {
    const frame = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
    expect(parseSseFrame(frame)).toBe('hello');
  });

  it('recognizes [DONE]', () => {
    expect(parseSseFrame('data: [DONE]')).toBe('[DONE]');
  });

  it('ignores comment/heartbeat lines', () => {
    expect(parseSseFrame(': ping\n\n')).toBeNull();
  });

  it('returns null when there is no content delta', () => {
    expect(parseSseFrame('data: {"choices":[{"delta":{}}]}')).toBeNull();
  });
});

describe('VeniceClient.streamChat', () => {
  it('yields incremental deltas from SSE frames', async () => {
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
    const out: string[] = [];
    for await (const d of client.streamChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      out.push(d);
    }
    expect(out.join('')).toBe('Hello');
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
    const out: string[] = [];
    for await (const d of client.streamChat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    })) {
      out.push(d);
    }
    expect(out.join('')).toBe('Hi');
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
