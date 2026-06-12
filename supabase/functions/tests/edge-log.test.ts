// Offline unit tests for the edge-side logger's broadcast wire shape.
// Pure: a fake fetch is injected and the env is supplied via opts, so
// these run under `deno test` with zero network and no Supabase. The
// browser end (appendFromEdge feeding the ring buffer) is covered in
// tests/edge-log-ingress.test.ts.
import { assertEquals } from '@std/assert';
import { createEdgeLogger } from '../_shared/edge-log.ts';

interface BroadcastBody {
  messages: Array<{
    topic: string;
    event: string;
    private: boolean;
    payload: {
      timestamp: number;
      level: string;
      source: string | null;
      message: string;
      details: Array<Record<string, unknown>>;
    };
  }>;
}

Deno.test('createEdgeLogger posts a private nak-log broadcast on the user topic', async () => {
  const calls: Array<{ url: string; headers: Headers; body: BroadcastBody }> = [];
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as BroadcastBody,
    });
    return Promise.resolve(new Response('{}', { status: 202 }));
  }) as typeof fetch;

  const log = createEdgeLogger('user-123', 'reflection', {
    fetchImpl: fakeFetch,
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc-key',
    now: () => 1000,
  });
  log.info('picked up thread t1');
  await log.flush();

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, 'https://proj.supabase.co/realtime/v1/api/broadcast');
  assertEquals(calls[0].headers.get('apikey'), 'svc-key');
  const msg = calls[0].body.messages[0];
  assertEquals(msg.topic, 'logs:user-123');
  assertEquals(msg.event, 'nak-log');
  assertEquals(msg.private, true);
  assertEquals(msg.payload.level, 'info');
  assertEquals(msg.payload.source, 'reflection');
  assertEquals(msg.payload.message, 'picked up thread t1');
  assertEquals(msg.payload.timestamp, 1000);
});

Deno.test('createEdgeLogger skips the broadcast when env is absent (console-only)', async () => {
  let called = false;
  const fakeFetch = (() => {
    called = true;
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  const log = createEdgeLogger('u', 'reflection', {
    fetchImpl: fakeFetch,
    supabaseUrl: '',
    serviceKey: '',
  });
  log.info('would-be entry');
  await log.flush();
  assertEquals(called, false);
});

Deno.test('createEdgeLogger serializes an Error detail as the error tag', async () => {
  const bodies: BroadcastBody[] = [];
  const fakeFetch = ((_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as BroadcastBody);
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  const log = createEdgeLogger('u', 'reflection', {
    fetchImpl: fakeFetch,
    supabaseUrl: 'https://x.co',
    serviceKey: 'k',
  });
  log.warn('reflection cycle failed', new Error('nope'));
  await log.flush();
  const detail = bodies[0].messages[0].payload.details[0];
  assertEquals(detail.kind, 'error');
  assertEquals(detail.message, 'nope');
});
