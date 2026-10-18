// Offline unit tests for the Venice chat/completions wire-shape used by the
// /complete proxy route. Pure: a fake fetch is injected so these run under
// `deno test` with zero network and no Supabase. The body-shaping logic
// stays in src/lib/venice.ts (browser-side) - this helper is a thin
// authenticated forwarder.
import { assert, assertEquals, assertRejects } from '@std/assert';
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

Deno.test('veniceComplete does NOT retry a 429 by default (opt-out: browser route + mid-turn tools)', async () => {
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

Deno.test('veniceComplete retries a 429 when retryRateLimit is set', async () => {
  // No Retry-After header, so the backoff uses the (zero) scheduled
  // delay and the test stays instant - the retryAfterMs-honoring path is
  // exercised by the mapping tests above, here we just pin that the
  // opt-in turns a 429 into a retryable transient.
  const { fetchImpl, calls } = sequencedFetch([
    new Response('slow down', { status: 429 }),
    okBody(),
  ]);
  const out = await veniceComplete({
    apiKey: 'k',
    body: {},
    fetchImpl,
    retrySchedule: [0],
    retryRateLimit: true,
  });
  assertEquals(
    (out as { choices: [{ message: { content: string } }] }).choices[0].message.content,
    'pong'
  );
  assertEquals(calls(), 2);
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

// Strict-validation fallback: some Venice backends 400 on optional
// knobs other backends ignore. The one-shot path re-issues without the
// named field (mapping the flattened 'verbosity' name back to 'text'),
// and never mutates the caller's body.
Deno.test('veniceComplete strips rejected advisory fields and retries', async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const rejections = ['verbosity', 'reasoning_effort'];
  const fakeFetch = ((_url: string | URL | Request, init?: RequestInit) => {
    sentBodies.push(JSON.parse(init!.body as string));
    const field = rejections.shift();
    if (field !== undefined) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: `Extra inputs are not permitted, field: '${field}'` }),
          { status: 400 }
        )
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  }) as typeof fetch;

  const body = {
    model: 'glm-5',
    messages: [{ role: 'user', content: 'ping' }],
    text: { verbosity: 'low' },
    reasoning_effort: 'low',
  };
  await veniceComplete({ apiKey: 'k', body, fetchImpl: fakeFetch, retrySchedule: [] });

  assertEquals(sentBodies.length, 3);
  assert(!('text' in sentBodies[1]), 'second attempt drops text');
  assertEquals(sentBodies[1].reasoning_effort, 'low');
  assert(!('reasoning_effort' in sentBodies[2]), 'third attempt drops reasoning_effort');
  assert('text' in body && 'reasoning_effort' in body, 'caller body untouched');
});

Deno.test('veniceComplete does not strip a non-droppable field', async () => {
  let calls = 0;
  const fakeFetch = (() => {
    calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: "Extra inputs are not permitted, field: 'tools'" }),
        { status: 400 }
      )
    );
  }) as typeof fetch;
  await assertRejects(
    () =>
      veniceComplete({
        apiKey: 'k',
        body: { model: 'glm-5', tools: [] },
        fetchImpl: fakeFetch,
        retrySchedule: [],
      }),
    VeniceError
  );
  assertEquals(calls, 1);
});
