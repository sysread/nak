// Offline unit tests for the mint-toast broadcast wire shape. Pure: a
// fake fetch is injected and the env is supplied via opts, so these run
// under `deno test` with zero network and no Supabase. The browser end
// (subscribeToSamskaraInserts feeding notifySamskaraMint) is exercised in
// the app's vitest suite.
import { assertEquals } from '@std/assert';
import { publishSamskaraMint } from '../_shared/samskara-mint.ts';

interface BroadcastBody {
  messages: Array<{
    topic: string;
    event: string;
    private: boolean;
    payload: { tier: number; valence: number; confidence: number };
  }>;
}

Deno.test('publishSamskaraMint posts a private samskara-mint broadcast on the user topic', async () => {
  const calls: Array<{ url: string; headers: Headers; body: BroadcastBody }> = [];
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as BroadcastBody,
    });
    return Promise.resolve(new Response('{}', { status: 202 }));
  }) as typeof fetch;

  await publishSamskaraMint(
    'user-123',
    { tier: 2, valence: -0.4, confidence: 0.8 },
    { fetchImpl: fakeFetch, supabaseUrl: 'https://proj.supabase.co', serviceKey: 'svc-key' },
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, 'https://proj.supabase.co/realtime/v1/api/broadcast');
  assertEquals(calls[0].headers.get('apikey'), 'svc-key');
  const msg = calls[0].body.messages[0];
  assertEquals(msg.topic, 'samskaras:user-123');
  assertEquals(msg.event, 'samskara-mint');
  assertEquals(msg.private, true);
  assertEquals(msg.payload.tier, 2);
  assertEquals(msg.payload.valence, -0.4);
  assertEquals(msg.payload.confidence, 0.8);
});

Deno.test('publishSamskaraMint skips the broadcast when env is absent', async () => {
  let called = false;
  const fakeFetch = (() => {
    called = true;
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  await publishSamskaraMint(
    'u',
    { tier: 1, valence: 0, confidence: 0.5 },
    { fetchImpl: fakeFetch, supabaseUrl: '', serviceKey: '' },
  );
  assertEquals(called, false);
});

Deno.test('publishSamskaraMint swallows a transport error - a toast never fails a mint', async () => {
  const fakeFetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;
  // Resolves rather than throwing; the mint path must not see this.
  await publishSamskaraMint(
    'u',
    { tier: 1, valence: 0, confidence: 0.5 },
    { fetchImpl: fakeFetch, supabaseUrl: 'https://x.co', serviceKey: 'k' },
  );
});
