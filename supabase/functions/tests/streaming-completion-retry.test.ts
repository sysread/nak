// Offline unit tests for withRateLimitRetry's retry branches, beyond the
// strict-validation strip covered in streaming-completion-strip.test.ts.
// The rate-limit and truncation branches previously had no direct tests;
// these pin them before the pre-event http/network branch slots in
// alongside (image-retry-data-uri-plan.md). Zero network: fake fetch.
import { assert, assertEquals } from '@std/assert';
import { getStreamingCompletion } from '../venice/getStreamingCompletion.ts';
import type { CompletionEvent, StreamSignal } from '../_shared/venice-stream.ts';

// Minimal well-formed SSE stream: one content delta, a stop frame, and
// the [DONE] sentinel (without it the wrapper treats the stream as
// truncated and retries).
const HAPPY_SSE = [
  'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  '',
].join('\n\n');

// SSE frames that stop without the [DONE] sentinel: the wrapper's
// truncation detector fires (no tool calls assembled either).
const CUT_SSE = [
  'data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}',
  '',
].join('\n\n');

async function collect(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  opts?: { httpRetryBackoffMs?: number }
): Promise<Array<CompletionEvent | StreamSignal>> {
  const events: Array<CompletionEvent | StreamSignal> = [];
  const ctl = new AbortController();
  for await (const ev of getStreamingCompletion({
    apiKey: 'k',
    body,
    signal: ctl.signal,
    fetchImpl,
    guardsOverride: [],
    ...opts,
  })) {
    events.push(ev);
  }
  return events;
}

const BODY = {
  model: 'z-ai-glm-5-3',
  messages: [{ role: 'user', content: 'ping' }],
};

Deno.test('rate-limit branch: 429 with Retry-After 0 retries and completes', async () => {
  // Retry-After: 0 keeps the honoring wait schedule real but instant,
  // so the test pins the branch without sleeping.
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        new Response('{"error":"rate limited"}', {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      );
    }
    return Promise.resolve(new Response(HAPPY_SSE, { status: 200 }));
  }) as typeof fetch;

  const events = await collect(BODY, fakeFetch);

  assertEquals(calls, 2);
  const waits = events.filter(
    (e): e is Extract<StreamSignal, { type: 'rate_limit_wait' }> =>
      e.type === 'rate_limit_wait'
  );
  assertEquals(waits.length, 1);
  assertEquals(waits[0].attempt, 1);
  assertEquals(waits[0].retryAfterMs, 0);
  assert(
    events.some((e) => e.type === 'rate_limit_resolved'),
    'wait resolves before the retry'
  );
  assertEquals(events.at(-1)?.type, 'DONE');
});

Deno.test('rate-limit branch: exhausted 429s surface a terminal error', async () => {
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    return Promise.resolve(
      new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { 'retry-after': '0' },
      }),
    );
  }) as typeof fetch;

  const events = await collect(BODY, fakeFetch);

  // RATE_LIMIT_MAX_ATTEMPTS = 3: three attempts, two waits.
  assertEquals(calls, 3);
  const waits = events.filter((e) => e.type === 'rate_limit_wait');
  assertEquals(waits.length, 2);
  const last = events.at(-1);
  assertEquals(last?.type, 'error');
  assert(
    last !== undefined && 'kind' in last && last.kind === 'rate_limit',
    'terminal error carries the rate_limit kind'
  );
});

Deno.test('truncation branch: cut stream without [DONE] retries and completes', async () => {
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(new Response(CUT_SSE, { status: 200 }));
    }
    return Promise.resolve(new Response(HAPPY_SSE, { status: 200 }));
  }) as typeof fetch;

  const events = await collect(BODY, fakeFetch);

  assertEquals(calls, 2);
  // Attempt 1 yielded text before the cut, so the stream_retry signal
  // rides out to tell consumers to reset their accumulators.
  const retries = events.filter(
    (e): e is Extract<StreamSignal, { type: 'stream_retry' }> =>
      e.type === 'stream_retry'
  );
  assertEquals(retries.length, 1);
  assertEquals(retries[0].reason, 'truncated');
  assertEquals(retries[0].attempt, 1);
  assertEquals(events.at(-1)?.type, 'DONE');
  const texts = events
    .filter((e): e is Extract<CompletionEvent, { type: 'response_text' }> =>
      e.type === 'response_text'
    )
    .map((e) => e.content);
  assertEquals(texts, ['par', 'hi']);
});

Deno.test('truncation branch: exhausted cuts surface a terminal error', async () => {
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    return Promise.resolve(new Response(CUT_SSE, { status: 200 }));
  }) as typeof fetch;

  const events = await collect(BODY, fakeFetch);

  // TRUNCATED_MAX_ATTEMPTS = 2: two attempts, one stream_retry signal.
  assertEquals(calls, 2);
  const retries = events.filter((e) => e.type === 'stream_retry');
  assertEquals(retries.length, 1);
  assertEquals(events.at(-1)?.type, 'error');
});

// Pre-event http/network retry (image-retry-data-uri-plan.md Change 1):
// a non-2xx Venice status other than 401/403/429, or a connect failure,
// throws before the first stream event and gets one automatic retry.
Deno.test('pre-event http failure retries once and completes', async () => {
  // The incident shape: a 400 (Venice's generic remote-image rejection)
  // on the first attempt, then a clean stream.
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: 'A remote image URL in the request could not be used.' }),
          { status: 400 }
        )
      );
    }
    return Promise.resolve(new Response(HAPPY_SSE, { status: 200 }));
  }) as typeof fetch;

  const events = await collect(BODY, fakeFetch, { httpRetryBackoffMs: 0 });

  assertEquals(calls, 2);
  // Pre-event retry is silent to consumers: no stream_retry signal
  // (nothing was emitted to reset) and no rate-limit events.
  assert(
    !events.some((e) => e.type === 'stream_retry'),
    'no stream_retry for a pre-event failure'
  );
  assert(!events.some((e) => e.type === 'rate_limit_wait'));
  assertEquals(events.at(-1)?.type, 'DONE');
  const text = events
    .filter((e): e is Extract<CompletionEvent, { type: 'response_text' }> =>
      e.type === 'response_text'
    )
    .map((e) => e.content)
    .join('');
  assertEquals(text, 'hi');
});

Deno.test('pre-event http failure that survives the retry is terminal', async () => {
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: 'A remote image URL in the request could not be used.' }),
        { status: 400 }
      )
    );
  }) as typeof fetch;

  const events = await collect(BODY, fakeFetch, { httpRetryBackoffMs: 0 });

  // HTTP_MAX_ATTEMPTS = 2: two attempts total, no third.
  assertEquals(calls, 2);
  const last = events.at(-1);
  assertEquals(last?.type, 'error');
  assert(
    last !== undefined && 'kind' in last && last.kind === 'http',
    'terminal error carries the http kind'
  );
});

Deno.test('pre-event network failure (connect reject) retries once and completes', async () => {
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    return Promise.resolve(new Response(HAPPY_SSE, { status: 200 }));
  }) as typeof fetch;

  const events = await collect(BODY, fakeFetch, { httpRetryBackoffMs: 0 });

  assertEquals(calls, 2);
  assertEquals(events.at(-1)?.type, 'DONE');
  assert(
    !events.some((e) => e.type === 'stream_retry'),
    'no stream_retry for a pre-event failure'
  );
});

Deno.test('a mid-stream read failure stays terminal (no post-emission retry)', async () => {
  // A response body that delivers one frame then breaks: the parse
  // error surfaces after events were emitted, which must stay terminal
  // even though the wrapper now retries pre-event failures.
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}\n\n'
          )
        );
        controller.error(new TypeError('stream interrupted'));
      },
    });
    return Promise.resolve(new Response(broken, { status: 200 }));
  }) as typeof fetch;

  const events = await collect(BODY, fakeFetch);

  assertEquals(calls, 1);
  const last = events.at(-1);
  assertEquals(last?.type, 'error');
  assert(
    last !== undefined && 'kind' in last,
    'terminal error event present'
  );
});
