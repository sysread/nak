// Offline unit tests for the models proxy helper. veniceFetchModels takes an
// injected fetch, so the GET wiring, verbatim relay, and the 429/other/network
// error mapping are exercised with fakes and no network. The browser
// (src/lib/models/catalog.ts) owns coercion of the relayed body, so the
// CatalogModel shape is not retested here - this is a thin passthrough.
import { assertEquals, assertRejects } from '@std/assert';
import { veniceFetchModels, VeniceError } from '../_shared/venice.ts';

function captureFetch(response: Response): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test('veniceFetchModels GETs /models?type=text and relays the body verbatim', async () => {
  const body = { object: 'list', type: 'text', data: [{ id: 'glm-5-1' }] };
  const { fetchImpl, calls } = captureFetch(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  const result = await veniceFetchModels({ apiKey: 'k', fetchImpl });
  assertEquals(result, body);
  assertEquals(calls[0].includes('/models?type=text'), true);
});

Deno.test('veniceFetchModels maps 429 to a rate_limit VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('slow down', { status: 429 }));
  await assertRejects(
    () => veniceFetchModels({ apiKey: 'k', fetchImpl }),
    VeniceError,
    'Venice models 429'
  );
});

Deno.test('veniceFetchModels maps a non-429 failure to an http VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('nope', { status: 500 }));
  await assertRejects(
    () => veniceFetchModels({ apiKey: 'k', fetchImpl }),
    VeniceError,
    'Venice models 500'
  );
});

Deno.test('veniceFetchModels maps a transport throw to a network VeniceError', async () => {
  const fetchImpl = (() => {
    throw new Error('connection refused');
  }) as unknown as typeof fetch;
  await assertRejects(
    () => veniceFetchModels({ apiKey: 'k', fetchImpl }),
    VeniceError,
    'Network error contacting Venice'
  );
});

Deno.test('veniceFetchModels maps a non-JSON 200 body to a parse VeniceError', async () => {
  const { fetchImpl } = captureFetch(
    new Response('<html>not json</html>', { status: 200 })
  );
  await assertRejects(
    () => veniceFetchModels({ apiKey: 'k', fetchImpl }),
    VeniceError,
    'Failed to parse Venice models response'
  );
});
