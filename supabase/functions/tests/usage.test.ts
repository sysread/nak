// Offline unit tests for the usage proxy helpers. buildUsageQuery is pure;
// veniceFetchUsagePage takes an injected fetch, so the success-shape parsing and
// the 429/other/parse/network error mapping are exercised with fakes and no
// network. The browser loop (src/lib/usage.ts) owns row coercion and the paging
// cap, so those are not retested here.
import { assertEquals, assertRejects } from '@std/assert';
import {
  buildUsageQuery,
  veniceFetchUsagePage,
  VeniceError,
} from '../_shared/venice.ts';

function captureFetch(response: Response): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test('buildUsageQuery assembles the fixed params in order', () => {
  const qs = buildUsageQuery({ page: 2, limit: 500, sortOrder: 'desc' });
  assertEquals(qs, 'limit=500&page=2&sortOrder=desc');
});

Deno.test('buildUsageQuery omits unset optional filters entirely', () => {
  const qs = buildUsageQuery({ page: 1, limit: 500, sortOrder: 'desc' });
  assertEquals(qs.includes('startDate'), false);
  assertEquals(qs.includes('endDate'), false);
  assertEquals(qs.includes('currency'), false);
});

Deno.test('buildUsageQuery includes and url-encodes the optional filters', () => {
  const qs = buildUsageQuery({
    page: 1,
    limit: 500,
    sortOrder: 'desc',
    startDate: '2026-05-01T00:00:00Z',
    endDate: '2026-05-08T00:00:00Z',
    currency: 'USD',
  });
  // URLSearchParams encodes the ISO timestamp's colons as %3A.
  assertEquals(qs.includes('startDate=2026-05-01T00%3A00%3A00Z'), true);
  assertEquals(qs.includes('endDate=2026-05-08T00%3A00%3A00Z'), true);
  assertEquals(qs.includes('currency=USD'), true);
});

Deno.test('veniceFetchUsagePage relays rows and the reported page count', async () => {
  const { fetchImpl, calls } = captureFetch(
    new Response(
      JSON.stringify({ data: [{ sku: 'a' }, { sku: 'b' }], pagination: { totalPages: 3 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );
  const result = await veniceFetchUsagePage({
    apiKey: 'k',
    params: { page: 2, limit: 500, sortOrder: 'desc', startDate: '2026-05-01T00:00:00Z' },
    fetchImpl,
  });
  assertEquals(result.data.length, 2);
  assertEquals(result.totalPages, 3);
  // The page params reached the upstream URL.
  assertEquals(calls[0].includes('/billing/usage?'), true);
  assertEquals(calls[0].includes('page=2'), true);
  assertEquals(calls[0].includes('startDate=2026-05-01T00%3A00%3A00Z'), true);
});

Deno.test('veniceFetchUsagePage defaults totalPages to 1 when pagination is absent', async () => {
  const { fetchImpl } = captureFetch(
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  const result = await veniceFetchUsagePage({
    apiKey: 'k',
    params: { page: 1, limit: 500, sortOrder: 'desc' },
    fetchImpl,
  });
  assertEquals(result.totalPages, 1);
});

Deno.test('veniceFetchUsagePage maps 429 to a rate_limit VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('slow down', { status: 429 }));
  const err = await assertRejects(
    () =>
      veniceFetchUsagePage({
        apiKey: 'k',
        params: { page: 1, limit: 500, sortOrder: 'desc' },
        fetchImpl,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
});

Deno.test('veniceFetchUsagePage maps a non-429 failure to an http VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('boom', { status: 500 }));
  const err = await assertRejects(
    () =>
      veniceFetchUsagePage({
        apiKey: 'k',
        params: { page: 1, limit: 500, sortOrder: 'desc' },
        fetchImpl,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 500);
});

Deno.test('veniceFetchUsagePage maps a non-JSON 200 body to a parse VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('not json', { status: 200 }));
  const err = await assertRejects(
    () =>
      veniceFetchUsagePage({
        apiKey: 'k',
        params: { page: 1, limit: 500, sortOrder: 'desc' },
        fetchImpl,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});

Deno.test('veniceFetchUsagePage maps a transport throw to a network VeniceError', async () => {
  const fetchImpl = (() => Promise.reject(new Error('offline'))) as typeof fetch;
  const err = await assertRejects(
    () =>
      veniceFetchUsagePage({
        apiKey: 'k',
        params: { page: 1, limit: 500, sortOrder: 'desc' },
        fetchImpl,
      }),
    VeniceError
  );
  assertEquals(err.kind, 'network');
});
