// Offline unit tests for the Venice /decisions relay used by the
// /decisions proxy route. Pure: a fake fetch is injected so these run
// under `deno test` with zero network and no Supabase. The body and
// the answers are opaque to the helper - the caller shapes the
// request and coerces the response - so these tests pin the relay
// contract: verbatim forward, verbatim parsed response, and the
// sibling error mapping.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { veniceDecision, VeniceError } from '../_shared/venice.ts';

const DECISION_RESPONSE = {
  model: 'clef-api',
  answers: {
    is_urgent: { type: 'noul', noul: 0.95 },
    tone: {
      type: 'choice',
      choice: 'mildly_frustrated',
      probabilities: { calm: 0.01, mildly_frustrated: 0.99, angry: 0 },
      confidence: 0.98,
    },
  },
  usage: { input_tokens: 546, output_tokens: 103 },
};

Deno.test('veniceDecision forwards the body verbatim and returns the parsed JSON', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(new Response(JSON.stringify(DECISION_RESPONSE), { status: 200 }));
  }) as typeof fetch;

  const body = {
    model: 'clef-api',
    state: { transcript: [{ role: 'user', content: 'ping' }] },
    questions: {
      is_urgent: { type: 'noul', instructions: 'Is this urgent?' },
    },
  };
  const out = await veniceDecision({ apiKey: 'k', body, fetchImpl: fakeFetch });

  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/decisions');
  // Body is forwarded verbatim - the helper does not inspect or reshape.
  assertEquals(JSON.parse(captured!.init.body as string), body);
  const headers = captured!.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer k');
  assertEquals(headers['Content-Type'], 'application/json');
  // Response comes back as-is for the caller to read answers from.
  const answers = (out as typeof DECISION_RESPONSE).answers;
  assertEquals(answers.is_urgent.noul, 0.95);
  assertEquals(answers.tone.choice, 'mildly_frustrated');
});

Deno.test('veniceDecision maps 429 to rate_limit and reads Retry-After', async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } })
    )) as typeof fetch;
  const err = await assertRejects(
    () => veniceDecision({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
  assertEquals(err.retryAfterMs, 7000);
});

Deno.test('veniceDecision falls back to x-ratelimit-reset-* when Retry-After is absent', async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response('slow down', {
        status: 429,
        headers: {
          'x-ratelimit-reset-requests': '3',
          'x-ratelimit-reset-tokens': '5',
        },
      })
    )) as typeof fetch;
  const err = await assertRejects(
    () => veniceDecision({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  // Picks the soonest of the two reset windows (3 s -> 3000 ms).
  assertEquals(err.retryAfterMs, 3000);
});

Deno.test('veniceDecision maps other non-OK statuses to http with the body snippet', async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ error: 'Invalid request parameters', details: { _errors: [] } }),
        { status: 400 }
      )
    )) as typeof fetch;
  const err = await assertRejects(
    () => veniceDecision({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 400);
  // The beta DetailedError body rides along for the 502 log.
  assert(err.message.includes('Invalid request parameters'));
});

Deno.test('veniceDecision truncates oversized error bodies at 600 chars', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('x'.repeat(2000), { status: 503 }))) as typeof fetch;
  const err = await assertRejects(
    () => veniceDecision({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 503);
  assert(err.message.length < 700);
});

Deno.test('veniceDecision maps connection failures to network', async () => {
  const fakeFetch = (() =>
    Promise.reject(new Error('connection refused'))) as typeof fetch;
  const err = await assertRejects(
    () => veniceDecision({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'network');
});

Deno.test('veniceDecision maps a non-JSON success body to parse', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('not json', { status: 200 }))) as typeof fetch;
  const err = await assertRejects(
    () => veniceDecision({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});
