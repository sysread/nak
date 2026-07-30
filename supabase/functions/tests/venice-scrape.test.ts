// Offline unit tests for the Venice /augment/scrape wire-shape. Pure: a
// fake fetch is injected, so these run under `deno test` with zero network
// and no Supabase. The web_search tool's url-mode glue (arg validation,
// truncation, self-citation) sits above this helper in
// ../venice/tools/web_search.ts.
import { assertEquals, assertRejects } from '@std/assert';
import { veniceScrapeUrl, VeniceError } from '../_shared/venice.ts';

Deno.test('veniceScrapeUrl posts the url as JSON and returns the content field', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          url: 'https://example.com/post',
          content: '# A page\n\nbody text',
          format: 'markdown',
        }),
        { status: 200 }
      )
    );
  }) as typeof fetch;

  const out = await veniceScrapeUrl({
    apiKey: 'test-key',
    url: 'https://example.com/post',
    fetchImpl: fakeFetch,
  });

  assertEquals(out, '# A page\n\nbody text');
  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/augment/scrape');
  const headers = captured!.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer test-key');
  assertEquals(headers['Content-Type'], 'application/json');
  assertEquals(
    JSON.parse(captured!.init.body as string),
    { url: 'https://example.com/post' }
  );
});

Deno.test('veniceScrapeUrl maps a 429 to a rate_limit VeniceError', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('slow down', { status: 429 }))) as typeof fetch;
  const err = await assertRejects(
    () => veniceScrapeUrl({ apiKey: 'k', url: 'https://a.example', fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
});

Deno.test('veniceScrapeUrl surfaces a blocked-host 400 body in the http error', async () => {
  // Venice rejects some hosts (X/Twitter, Reddit) with a 400 whose body
  // says so; the message must carry it so the model can tell the user
  // why the fetch failed rather than retrying blindly.
  const fakeFetch = (() =>
    Promise.resolve(new Response('this site cannot be scraped', { status: 400 }))) as typeof fetch;
  const err = await assertRejects(
    () => veniceScrapeUrl({ apiKey: 'k', url: 'https://x.com/some/post', fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 400);
  assertEquals(err.message.includes('this site cannot be scraped'), true);
});

Deno.test('veniceScrapeUrl treats an empty content field as a parse error', async () => {
  // A blank page body reads as success to the caller and gives the model
  // nothing; fail loud instead.
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ url: 'https://a.example', content: '', format: 'markdown' }), {
        status: 200,
      })
    )) as typeof fetch;
  const err = await assertRejects(
    () => veniceScrapeUrl({ apiKey: 'k', url: 'https://a.example', fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});

Deno.test('veniceScrapeUrl treats a missing content field as a parse error', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))) as typeof fetch;
  const err = await assertRejects(
    () => veniceScrapeUrl({ apiKey: 'k', url: 'https://a.example', fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});
