// Offline unit tests for the usage-analytics proxy helpers. buildAnalyticsQuery
// is pure; veniceFetchUsageAnalytics takes an injected fetch, so the
// success-shape passthrough and the 429/other/parse/network error mapping are
// exercised with fakes and no network. The browser (src/lib/usage.ts) owns
// coercion of the `byModel` slice, so that is not retested here.
import { assertEquals, assertRejects } from '@std/assert';
import {
  buildAnalyticsQuery,
  veniceFetchUsageAnalytics,
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

Deno.test('buildAnalyticsQuery forwards an explicit date range', () => {
  const qs = buildAnalyticsQuery({ startDate: '2026-06-19', endDate: '2026-06-26' });
  assertEquals(qs, 'startDate=2026-06-19&endDate=2026-06-26');
});

Deno.test('buildAnalyticsQuery falls back to the default lookback when no range is given', () => {
  assertEquals(buildAnalyticsQuery({}), 'lookback=7d');
});

Deno.test('buildAnalyticsQuery treats a half-set range as no range', () => {
  // Venice requires both bounds together; a lone startDate must not be
  // forwarded half-set, so we fall back to the lookback.
  assertEquals(buildAnalyticsQuery({ startDate: '2026-06-19' }), 'lookback=7d');
  assertEquals(buildAnalyticsQuery({ endDate: '2026-06-26' }), 'lookback=7d');
});

Deno.test('veniceFetchUsageAnalytics relays the JSON body verbatim', async () => {
  const payload = { byModel: [{ modelName: 'GLM 5.1', totalUsd: 0.4 }], lookback: '7d' };
  const { fetchImpl, calls } = captureFetch(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  const result = await veniceFetchUsageAnalytics({
    apiKey: 'k',
    params: { startDate: '2026-06-19', endDate: '2026-06-26' },
    fetchImpl,
  });
  assertEquals(result, payload);
  // The range reached the upstream URL.
  assertEquals(calls[0].includes('/billing/usage-analytics?'), true);
  assertEquals(calls[0].includes('startDate=2026-06-19'), true);
  assertEquals(calls[0].includes('endDate=2026-06-26'), true);
});

Deno.test('veniceFetchUsageAnalytics maps 429 to a rate_limit VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('slow down', { status: 429 }));
  const err = await assertRejects(
    () => veniceFetchUsageAnalytics({ apiKey: 'k', params: {}, fetchImpl }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
});

Deno.test('veniceFetchUsageAnalytics maps a non-429 failure to an http VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('boom', { status: 500 }));
  const err = await assertRejects(
    () => veniceFetchUsageAnalytics({ apiKey: 'k', params: {}, fetchImpl }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 500);
});

Deno.test('veniceFetchUsageAnalytics maps a non-JSON 200 body to a parse VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('not json', { status: 200 }));
  const err = await assertRejects(
    () => veniceFetchUsageAnalytics({ apiKey: 'k', params: {}, fetchImpl }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});

Deno.test('veniceFetchUsageAnalytics maps a transport throw to a network VeniceError', async () => {
  const fetchImpl = (() => Promise.reject(new Error('offline'))) as typeof fetch;
  const err = await assertRejects(
    () => veniceFetchUsageAnalytics({ apiKey: 'k', params: {}, fetchImpl }),
    VeniceError
  );
  assertEquals(err.kind, 'network');
});
