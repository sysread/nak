// Offline unit tests for the Venice image-edit wire-shapes. Pure: a fake
// fetch is injected, so these run under `deno test` with zero network and no
// Supabase. The handler glue in ../venice/index.ts (CORS, routing, app_config
// read) is exercised live against a local stack, not here.
//
// The edit-family endpoints return RAW BYTES with the format in the
// Content-Type header (unlike /image/generate's JSON envelope), so the
// success-shape tests pin that contract: base64 out, mime from the header.
import { assertEquals, assertRejects } from '@std/assert';
import {
  veniceEditImage,
  veniceRemoveBackground,
  veniceUpscaleImage,
  VeniceError,
} from '../_shared/venice.ts';

// 4 bytes of PNG-ish payload, base64-encoded ("fake" = 0x7e 0x61 0x6b 0x65).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function binaryResponse(
  contentType = 'image/png'
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (_url, _init) =>
    Promise.resolve(new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': contentType } }));
}

Deno.test('veniceEditImage posts the strict body and decodes the binary response', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/webp' },
      })
    );
  }) as typeof fetch;

  const out = await veniceEditImage({
    apiKey: 'test-key',
    model: 'firered-image-edit',
    prompt: 'make the sky a sunset',
    image: 'data:image/jpeg;base64,AAAA',
    fetchImpl: fakeFetch,
  });

  assertEquals(out, { imageBase64: 'iVBORw==', mimeType: 'image/webp' });
  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/image/edit');
  // Strict-body endpoint: only fields Venice declares. aspect_ratio is
  // deliberately absent - Venice infers it from the input image.
  assertEquals(JSON.parse(captured!.init.body as string), {
    model: 'firered-image-edit',
    prompt: 'make the sky a sunset',
    image: 'data:image/jpeg;base64,AAAA',
    output_format: 'webp',
    safe_mode: true,
  });
  const headers = captured!.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer test-key');
  assertEquals(headers['Content-Type'], 'application/json');
});

Deno.test('veniceEditImage maps 422 to a content-policy http error', async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(
        '{"error":"Your prompt violates the content policy of Venice.ai or the model provider"}',
        { status: 422 }
      )
    )) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceEditImage({
        apiKey: 'k',
        model: 'm',
        prompt: 'x',
        image: 'AAAA',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 422);
  assertEquals(err.message.includes('content-policy'), true);
});

Deno.test('veniceEditImage checks the content-violation header on a 200', async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(PNG_BYTES, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'x-venice-is-content-violation': 'true',
        },
      })
    )) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceEditImage({
        apiKey: 'k',
        model: 'm',
        prompt: 'x',
        image: 'AAAA',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
});

Deno.test('veniceEditImage maps 429 to rate_limit', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('slow down', { status: 429 }))) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceEditImage({
        apiKey: 'k',
        model: 'm',
        prompt: 'x',
        image: 'AAAA',
        fetchImpl: fakeFetch,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
});

Deno.test('veniceUpscaleImage sends RAW base64 (no data URI) plus scale', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(
      new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } })
    );
  }) as typeof fetch;

  const out = await veniceUpscaleImage({
    apiKey: 'k',
    image: 'RAWB64',
    scale: 4,
    fetchImpl: fakeFetch,
  });

  assertEquals(out, { imageBase64: 'iVBORw==', mimeType: 'image/png' });
  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/image/upscale');
  // The upscale endpoint rejects data URIs and ignores unknown fields; the
  // wire body carries exactly image + scale (creativity only when supplied).
  assertEquals(JSON.parse(captured!.init.body as string), {
    image: 'RAWB64',
    scale: 4,
  });
});

Deno.test('veniceUpscaleImage forwards creativity only when set', async () => {
  const calls: Record<string, unknown>[] = [];
  const fakeFetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse((init?.body as string) ?? '{}'));
    return binaryResponse()( _url, init);
  }) as typeof fetch;

  await veniceUpscaleImage({ apiKey: 'k', image: 'A', scale: 2, fetchImpl: fakeFetch });
  await veniceUpscaleImage({ apiKey: 'k', image: 'A', scale: 2, creativity: 0.02, fetchImpl: fakeFetch });

  assertEquals('creativity' in calls[0], false);
  assertEquals(calls[1].creativity, 0.02);
});

Deno.test('veniceRemoveBackground posts the image and decodes the binary response', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return binaryResponse()(url, init);
  }) as typeof fetch;

  const out = await veniceRemoveBackground({
    apiKey: 'k',
    image: 'data:image/png;base64,AAAA',
    fetchImpl: fakeFetch,
  });

  assertEquals(out, { imageBase64: 'iVBORw==', mimeType: 'image/png' });
  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/image/background-remove');
  assertEquals(JSON.parse(captured!.init.body as string), {
    image: 'data:image/png;base64,AAAA',
  });
});

Deno.test('edit-family helpers throw parse on an empty binary response', async () => {
  // All three share imageOpResponseToBase64; one representative helper
  // pins the empty-body guard.
  const emptyFetch = (() =>
    Promise.resolve(
      new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'image/png' } })
    )) as typeof fetch;
  const err = await assertRejects(
    () => veniceRemoveBackground({ apiKey: 'k', image: 'A', fetchImpl: emptyFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});
