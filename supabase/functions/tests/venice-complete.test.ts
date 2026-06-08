// Offline unit tests for the Venice chat/completions wire-shape used by the
// /complete proxy route. Pure: a fake fetch is injected so these run under
// `deno test` with zero network and no Supabase. The body-shaping logic
// stays in src/lib/venice.ts (browser-side) - this helper is a thin
// authenticated forwarder.
import { assertEquals, assertRejects } from '@std/assert';
import { veniceComplete, VeniceError } from '../_shared/venice.ts';

Deno.test('veniceComplete forwards the body verbatim and returns the parsed JSON', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'cmpl-1',
          choices: [{ message: { content: 'pong' } }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
        { status: 200 }
      )
    );
  }) as typeof fetch;

  const body = {
    model: 'glm-4.7',
    messages: [{ role: 'user', content: 'ping' }],
    venice_parameters: { include_venice_system_prompt: false },
  };
  const out = await veniceComplete({ apiKey: 'k', body, fetchImpl: fakeFetch });

  assertEquals(captured!.url, 'https://api.venice.ai/api/v1/chat/completions');
  // Body is forwarded verbatim - the function does not inspect or reshape.
  assertEquals(JSON.parse(captured!.init.body as string), body);
  const headers = captured!.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer k');
  assertEquals(headers['Content-Type'], 'application/json');
  // Response comes back as-is for the browser to feed parseChatCompletion.
  assertEquals(
    (out as { choices: [{ message: { content: string } }] }).choices[0].message.content,
    'pong'
  );
});

Deno.test('veniceComplete maps 429 to rate_limit and reads Retry-After', async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } })
    )) as typeof fetch;
  const err = await assertRejects(
    () => veniceComplete({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(err.status, 429);
  // 7 seconds -> 7000 ms, regardless of whether Retry-After arrived as
  // delta-seconds or HTTP-date.
  assertEquals(err.retryAfterMs, 7000);
});

Deno.test('veniceComplete falls back to x-ratelimit-reset-* when Retry-After is absent', async () => {
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
    () => veniceComplete({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  // Picks the soonest of the two reset windows (3 s -> 3000 ms).
  assertEquals(err.retryAfterMs, 3000);
});

Deno.test('veniceComplete maps other non-OK statuses to http', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch;
  // retrySchedule:[] isolates the classifier - this asserts the mapping,
  // not the retry loop (covered separately below).
  const err = await assertRejects(
    () => veniceComplete({ apiKey: 'k', body: {}, fetchImpl: fakeFetch, retrySchedule: [] }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 500);
  assertEquals(err.retryAfterMs, null);
});

// A fetch stub that replays a programmed sequence of Responses (or
// throws, for a connection-level failure), one per call, and counts how
// many times it ran. The last entry repeats if the loop overshoots.
function sequencedFetch(
  steps: Array<Response | (() => never)>,
): { fetchImpl: typeof fetch; calls: () => number } {
  let i = 0;
  const fetchImpl = (() => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (typeof step === 'function') return Promise.reject(new TypeError('connection reset'));
    // Clone so a repeated last entry can be re-read.
    return Promise.resolve(step.clone());
  }) as typeof fetch;
  return { fetchImpl, calls: () => i };
}

const okBody = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
    status: 200,
  });

Deno.test('veniceComplete retries a transient 5xx and then succeeds', async () => {
  const { fetchImpl, calls } = sequencedFetch([
    new Response('busy', { status: 503 }),
    new Response('busy', { status: 503 }),
    okBody(),
  ]);
  const out = await veniceComplete({
    apiKey: 'k',
    body: {},
    fetchImpl,
    // Zero-delay schedule keeps the test instant while still exercising
    // the two-retry-then-succeed path.
    retrySchedule: [0, 0],
  });
  assertEquals(
    (out as { choices: [{ message: { content: string } }] }).choices[0].message.content,
    'pong'
  );
  assertEquals(calls(), 3);
});

Deno.test('veniceComplete retries a connection-level failure and then succeeds', async () => {
  const { fetchImpl, calls } = sequencedFetch([() => { throw 0; }, okBody()]);
  const out = await veniceComplete({
    apiKey: 'k',
    body: {},
    fetchImpl,
    retrySchedule: [0],
  });
  assertEquals(
    (out as { choices: [{ message: { content: string } }] }).choices[0].message.content,
    'pong'
  );
  assertEquals(calls(), 2);
});

Deno.test('veniceComplete exhausts the retry schedule on a sustained 5xx', async () => {
  const { fetchImpl, calls } = sequencedFetch([new Response('down', { status: 504 })]);
  const err = await assertRejects(
    () => veniceComplete({ apiKey: 'k', body: {}, fetchImpl, retrySchedule: [0, 0] }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 504);
  // Initial attempt + 2 scheduled retries.
  assertEquals(calls(), 3);
});

Deno.test('veniceComplete does NOT retry a 4xx', async () => {
  const { fetchImpl, calls } = sequencedFetch([new Response('bad', { status: 400 })]);
  const err = await assertRejects(
    () => veniceComplete({ apiKey: 'k', body: {}, fetchImpl, retrySchedule: [0, 0] }),
    VeniceError
  );
  assertEquals(err.kind, 'http');
  assertEquals(err.status, 400);
  assertEquals(calls(), 1);
});

Deno.test('veniceComplete does NOT retry a 429 (the browser loop owns that)', async () => {
  const { fetchImpl, calls } = sequencedFetch([
    new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }),
  ]);
  const err = await assertRejects(
    () => veniceComplete({ apiKey: 'k', body: {}, fetchImpl, retrySchedule: [0, 0] }),
    VeniceError
  );
  assertEquals(err.kind, 'rate_limit');
  assertEquals(calls(), 1);
});

Deno.test('veniceComplete maps a non-JSON success body to parse', async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response('not json', { status: 200 }))) as typeof fetch;
  const err = await assertRejects(
    () => veniceComplete({ apiKey: 'k', body: {}, fetchImpl: fakeFetch }),
    VeniceError
  );
  assertEquals(err.kind, 'parse');
});
