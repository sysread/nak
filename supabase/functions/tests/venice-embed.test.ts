// Offline unit tests for the Venice embed wire-shape. Pure: a fake fetch is
// injected, so these run under `deno test` with zero network and no Supabase.
// The handler glue in ../venice/index.ts (CORS, routing, app_config read) is
// exercised via `supabase functions serve` against the local stack, not here.
import { assertEquals, assertRejects } from '@std/assert';
import { veniceEmbed, VeniceError } from '../_shared/venice.ts';

Deno.test('veniceEmbed posts the OpenAI-shaped body and returns the data array', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
      })
    );
  }) as typeof fetch;

  const out = await veniceEmbed({
    apiKey: 'test-key',
    model: 'text-embedding-bge-m3',
    input: 'hello',
    fetchImpl: fakeFetch,
  });

  assertEquals(out.data[0].embedding, [0.1, 0.2, 0.3]);
  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/embeddings');
  assertEquals(JSON.parse(captured!.init.body as string), {
    model: 'text-embedding-bge-m3',
    input: 'hello',
  });
  const headers = captured!.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer test-key');
});

Deno.test('veniceEmbed maps a 429 to a rate_limit VeniceError', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('slow down', { status: 429 }))) as typeof fetch;
  const err = await assertRejects(
    () => veniceEmbed({ apiKey: 'k', model: 'm', input: 'x', fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
});

Deno.test('veniceEmbed maps other non-OK statuses to an http VeniceError', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch;
  const err = await assertRejects(
    () => veniceEmbed({ apiKey: 'k', model: 'm', input: 'x', fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
});
