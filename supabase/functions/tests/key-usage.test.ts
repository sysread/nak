// Offline unit tests for the per-key usage proxy. Two things are under test
// and they fail in different ways, so they are covered separately:
//
//   selectKeyUsage    - picks OUR key's row out of Venice's /api_keys list by
//                       key suffix. Getting this wrong attributes another
//                       key's spend to nak, which is the exact bug the whole
//                       feature exists to fix, so the fail-closed paths carry
//                       as much weight here as the happy path.
//   veniceFetchKeyUsage - the GET wiring and 429/other/network error mapping,
//                       exercised with an injected fetch and no network.
import { assertEquals, assertRejects } from '@std/assert';
import { selectKeyUsage, veniceFetchKeyUsage, VeniceError } from '../_shared/venice.ts';

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    apiKeyType: 'ADMIN',
    description: 'nak-personal',
    id: '0bcf9073-ce79-4aaa-ab0b-924b74669c8e',
    last6Chars: '2i2YGU',
    lastUsedAt: '2026-07-27T20:45:03.304Z',
    usage: { trailingSevenDays: { usd: '12.4299', vcu: '0.0000', diem: '0.0000' } },
    ...overrides,
  };
}

Deno.test('selectKeyUsage picks the row matching the key suffix', () => {
  const payload = {
    object: 'list',
    data: [
      keyRow({
        description: 'opencode',
        last6Chars: 'GFoBux',
        usage: { trailingSevenDays: { usd: '143.8535', vcu: '0', diem: '0' } },
      }),
      keyRow(),
    ],
  };
  assertEquals(selectKeyUsage(payload, '2i2YGU'), {
    description: 'nak-personal',
    usd: 12.4299,
    diem: 0,
  });
});

Deno.test('selectKeyUsage parses DIEM spend alongside USD', () => {
  const payload = {
    data: [keyRow({ usage: { trailingSevenDays: { usd: '1.5', vcu: '0', diem: '4.25' } } })],
  };
  assertEquals(selectKeyUsage(payload, '2i2YGU')?.diem, 4.25);
});

Deno.test('selectKeyUsage returns null when no row matches the suffix', () => {
  const payload = { data: [keyRow({ last6Chars: 'ZZZZZZ' })] };
  assertEquals(selectKeyUsage(payload, '2i2YGU'), null);
});

// The collision guard. Six characters is a small key space; picking either
// match would silently report someone else's spend as nak's.
Deno.test('selectKeyUsage returns null when two rows share the suffix', () => {
  const payload = {
    data: [
      keyRow({ description: 'first' }),
      keyRow({ description: 'second' }),
    ],
  };
  assertEquals(selectKeyUsage(payload, '2i2YGU'), null);
});

Deno.test('selectKeyUsage returns null on a malformed payload', () => {
  assertEquals(selectKeyUsage(null, '2i2YGU'), null);
  assertEquals(selectKeyUsage({}, '2i2YGU'), null);
  assertEquals(selectKeyUsage({ data: 'nope' }, '2i2YGU'), null);
  assertEquals(selectKeyUsage({ data: [keyRow({ usage: {} })] }, '2i2YGU'), null);
});

// An unparseable figure degrades to 0 rather than dropping the row - the same
// stance the analytics coercer takes on an absent currency total.
Deno.test('selectKeyUsage degrades an unparseable spend figure to 0', () => {
  const payload = {
    data: [keyRow({ usage: { trailingSevenDays: { usd: 'n/a', vcu: '0', diem: null } } })],
  };
  assertEquals(selectKeyUsage(payload, '2i2YGU'), {
    description: 'nak-personal',
    usd: 0,
    diem: 0,
  });
});

Deno.test('selectKeyUsage falls back to a generic label when description is missing', () => {
  const payload = { data: [keyRow({ description: '' })] };
  assertEquals(selectKeyUsage(payload, '2i2YGU')?.description, 'this key');
});

function captureFetch(response: Response): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test('veniceFetchKeyUsage GETs /api_keys and selects by the key suffix', async () => {
  const { fetchImpl, calls } = captureFetch(
    new Response(JSON.stringify({ data: [keyRow()] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  // The suffix is derived from the key itself, not configured anywhere.
  const result = await veniceFetchKeyUsage({ apiKey: 'sk-whatever-2i2YGU', fetchImpl });
  assertEquals(result, { description: 'nak-personal', usd: 12.4299, diem: 0 });
  assertEquals(calls[0].endsWith('/api_keys'), true);
});

Deno.test('veniceFetchKeyUsage resolves null when the key is not in the list', async () => {
  const { fetchImpl } = captureFetch(
    new Response(JSON.stringify({ data: [keyRow()] }), { status: 200 })
  );
  assertEquals(await veniceFetchKeyUsage({ apiKey: 'sk-other-ABCDEF', fetchImpl }), null);
});

// 401 is the expected shape when the shared key is INFERENCE-typed rather than
// ADMIN, since /api_keys is ADMIN-only.
Deno.test('veniceFetchKeyUsage maps a 401 to an http VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('unauthorized', { status: 401 }));
  await assertRejects(
    () => veniceFetchKeyUsage({ apiKey: 'k', fetchImpl }),
    VeniceError,
    'Venice api_keys 401'
  );
});

Deno.test('veniceFetchKeyUsage maps 429 to a rate_limit VeniceError', async () => {
  const { fetchImpl } = captureFetch(new Response('slow down', { status: 429 }));
  await assertRejects(
    () => veniceFetchKeyUsage({ apiKey: 'k', fetchImpl }),
    VeniceError,
    'Venice api_keys 429'
  );
});

Deno.test('veniceFetchKeyUsage maps a network failure to a network VeniceError', async () => {
  const fetchImpl = (() => Promise.reject(new Error('boom'))) as typeof fetch;
  await assertRejects(
    () => veniceFetchKeyUsage({ apiKey: 'k', fetchImpl }),
    VeniceError,
    'Network error contacting Venice'
  );
});
