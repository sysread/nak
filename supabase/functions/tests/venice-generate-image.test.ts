// Offline unit tests for the Venice image-generate wire-shape. Pure: a fake
// fetch is injected, so these run under `deno test` with zero network and no
// Supabase. The handler glue in ../venice/index.ts (CORS, routing, app_config
// read) is exercised live against a local stack, not here.
import { assertEquals, assertRejects } from '@std/assert';
import { veniceGenerateImage, VeniceError } from '../_shared/venice.ts';

Deno.test('veniceGenerateImage posts the snake-cased body and returns the first image as base64', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'g1', images: ['BASE64DATA'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;

  const out = await veniceGenerateImage({
    apiKey: 'test-key',
    model: 'venice-sd35',
    prompt: 'a cat',
    width: 1024,
    height: 1024,
    fetchImpl: fakeFetch,
  });

  assertEquals(out, { imageBase64: 'BASE64DATA', mimeType: 'image/webp' });
  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/image/generate');
  const body = JSON.parse(captured!.init.body as string);
  // Camel-case in -> snake_case out. variants/return_binary/safe_mode are
  // pinned defaults so the helper never returns multi-image or raw bytes.
  assertEquals(body, {
    model: 'venice-sd35',
    prompt: 'a cat',
    format: 'webp',
    variants: 1,
    safe_mode: true,
    return_binary: false,
    width: 1024,
    height: 1024,
  });
  const headers = captured!.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer test-key');
  assertEquals(headers['Content-Type'], 'application/json');
});

Deno.test('veniceGenerateImage forwards hide_watermark only when set', async () => {
  const calls: Record<string, unknown>[] = [];
  const fakeFetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse((init?.body as string) ?? '{}'));
    return Promise.resolve(
      new Response(JSON.stringify({ images: ['B64'] }), { status: 200 })
    );
  }) as typeof fetch;

  await veniceGenerateImage({
    apiKey: 'k',
    model: 'm',
    prompt: 'x',
    hideWatermark: true,
    fetchImpl: fakeFetch,
  });
  await veniceGenerateImage({
    apiKey: 'k',
    model: 'm',
    prompt: 'x',
    fetchImpl: fakeFetch,
  });

  assertEquals(calls[0].hide_watermark, true);
  assertEquals('hide_watermark' in calls[1], false);
});

Deno.test('veniceGenerateImage throws on content-policy violation header even with HTTP 200', async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ images: [] }), {
        status: 200,
        headers: { 'x-venice-is-content-violation': 'true' },
      })
    )) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceGenerateImage({
        apiKey: 'k',
        model: 'm',
        prompt: 'x',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
});

Deno.test('veniceGenerateImage throws when the response carries no image data', async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ images: [] }), { status: 200 })
    )) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceGenerateImage({
        apiKey: 'k',
        model: 'm',
        prompt: 'x',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});

Deno.test('veniceGenerateImage maps 429 to rate_limit', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('slow down', { status: 429 }))) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceGenerateImage({
        apiKey: 'k',
        model: 'm',
        prompt: 'x',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
});

Deno.test('veniceGenerateImage maps other non-OK statuses to http', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceGenerateImage({
        apiKey: 'k',
        model: 'm',
        prompt: 'x',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
});
