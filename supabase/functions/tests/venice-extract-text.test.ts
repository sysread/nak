// Offline unit tests for the Venice text-parser wire-shape. Pure: a fake
// fetch is injected, so these run under `deno test` with zero network and no
// Supabase. The handler glue in ../venice/index.ts (CORS, routing,
// app_config read, multipart parsing) is exercised live against a local
// stack, not here.
import { assertEquals, assertRejects } from '@std/assert';
import { veniceExtractText, VeniceError } from '../_shared/venice.ts';

Deno.test('veniceExtractText posts multipart with the file part and returns text', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(
      new Response(JSON.stringify({ text: 'hello from a pdf' }), { status: 200 })
    );
  }) as typeof fetch;

  const file = new Blob(['contents'], { type: 'text/plain' });
  const out = await veniceExtractText({
    apiKey: 'test-key',
    file,
    filename: 'dishes.txt',
    fetchImpl: fakeFetch,
  });

  assertEquals(out, 'hello from a pdf');
  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/augment/text-parser');
  // The body is a FormData - no JSON Content-Type would be set, so the
  // outgoing fetch leaves Content-Type unset and the runtime generates
  // multipart with the boundary itself. The Authorization header must still
  // be the explicit Bearer.
  const headers = captured!.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer test-key');
  // Inspect the FormData parts directly: file with the right filename, plus
  // the response_format flag so Venice returns structured JSON.
  const form = captured!.init.body as FormData;
  const fileOut = form.get('file');
  assertEquals(fileOut instanceof Blob, true);
  assertEquals((fileOut as File).name, 'dishes.txt');
  assertEquals(form.get('response_format'), 'json');
});

Deno.test('veniceExtractText falls back through alternate body shapes', async () => {
  // Venice doc shape is `{ text }`, but a wire tweak might return
  // `{ content }` or `{ data: { text } }`; assert the helper tolerates both.
  const file = new Blob(['x'], { type: 'text/plain' });
  const altContent = (() =>
    Promise.resolve(new Response(JSON.stringify({ content: 'from content' }), { status: 200 }))) as typeof fetch;
  const nested = (() =>
    Promise.resolve(new Response(JSON.stringify({ data: { text: 'nested' } }), { status: 200 }))) as typeof fetch;

  assertEquals(
    await veniceExtractText({ apiKey: 'k', file, filename: 'f', fetchImpl: altContent }),
    'from content'
  );
  assertEquals(
    await veniceExtractText({ apiKey: 'k', file, filename: 'f', fetchImpl: nested }),
    'nested'
  );
});

Deno.test('veniceExtractText maps a 429 to a rate_limit VeniceError', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('slow down', { status: 429 }))) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceExtractText({
        apiKey: 'k',
        file: new Blob(['x']),
        filename: 'f',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
});

Deno.test('veniceExtractText maps other non-OK statuses to an http VeniceError', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceExtractText({
        apiKey: 'k',
        file: new Blob(['x']),
        filename: 'f',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
});

Deno.test('veniceExtractText surfaces a missing text field as a parse error', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceExtractText({
        apiKey: 'k',
        file: new Blob(['x']),
        filename: 'f',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});
