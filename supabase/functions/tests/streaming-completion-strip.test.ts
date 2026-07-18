// Offline unit tests for getStreamingCompletion's strict-validation
// fallback. Some Venice model backends (GLM 5.x was the first observed)
// run strict pydantic validation on the forwarded request body and 400
// the whole request with "Extra inputs are not permitted, field: 'X'"
// for optional knobs other backends silently ignore. The retry wrapper
// strips a droppable field from the body in place and re-issues; these
// tests pin that behavior with a fake fetch, zero network.
import { assert, assertEquals } from '@std/assert';
import { getStreamingCompletion } from '../venice/getStreamingCompletion.ts';
import type { CompletionEvent, StreamSignal } from '../_shared/venice-stream.ts';

const EXTRA_TEXT_400 = JSON.stringify({
  error: "Extra inputs are not permitted, field: 'text'",
  request_id: 'req-test',
});

// Minimal well-formed SSE stream: one content delta, a stop frame, and
// the [DONE] sentinel (without it the wrapper treats the stream as
// truncated and retries).
const HAPPY_SSE = [
  'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  '',
].join('\n\n');

async function collect(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Array<CompletionEvent | StreamSignal>> {
  const events: Array<CompletionEvent | StreamSignal> = [];
  const ctl = new AbortController();
  for await (const ev of getStreamingCompletion({
    apiKey: 'k',
    body,
    signal: ctl.signal,
    fetchImpl,
    guardsOverride: [],
  })) {
    events.push(ev);
  }
  return events;
}

Deno.test('strips a rejected droppable field and retries successfully', async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const fakeFetch = ((_url: string | URL | Request, init?: RequestInit) => {
    sentBodies.push(JSON.parse(init!.body as string));
    if (sentBodies.length === 1) {
      return Promise.resolve(new Response(EXTRA_TEXT_400, { status: 400 }));
    }
    return Promise.resolve(new Response(HAPPY_SSE, { status: 200 }));
  }) as typeof fetch;

  const body: Record<string, unknown> = {
    model: 'zai-org-glm-5-2',
    messages: [{ role: 'user', content: 'ping' }],
    text: { verbosity: 'low' },
  };
  const events = await collect(body, fakeFetch);

  assertEquals(sentBodies.length, 2);
  assert('text' in sentBodies[0], 'first attempt carries the knob');
  assert(!('text' in sentBodies[1]), 'retry goes out without the knob');
  // The strip mutates the caller's body in place on purpose: the
  // orchestrator re-issues the same body object every tool round, so
  // the turn pays the extra 400 round-trip once, not once per round.
  assert(!('text' in body), 'caller body is stripped in place');

  const text = events
    .filter((e): e is Extract<CompletionEvent, { type: 'response_text' }> =>
      e.type === 'response_text'
    )
    .map((e) => e.content)
    .join('');
  assertEquals(text, 'hi');
  assertEquals(events.at(-1)?.type, 'DONE');
  assert(!events.some((e) => e.type === 'error'), 'no error event surfaced');

  // The discovery signal rides the event stream so the orchestrator
  // can persist it to model_feature_rejections.
  const signals = events.filter(
    (e): e is Extract<StreamSignal, { type: 'wire_feature_rejected' }> =>
      e.type === 'wire_feature_rejected'
  );
  assertEquals(signals.length, 1);
  assertEquals(signals[0].field, 'text');
});

Deno.test('a repeat 400 naming an already-stripped field is terminal', async () => {
  // Guards against an infinite strip loop: once the field is gone from
  // the body, the same 400 must fall through to the error event rather
  // than re-issuing forever.
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    return Promise.resolve(new Response(EXTRA_TEXT_400, { status: 400 }));
  }) as typeof fetch;

  const events = await collect(
    {
      model: 'zai-org-glm-5-2',
      messages: [{ role: 'user', content: 'ping' }],
      text: { verbosity: 'low' },
    },
    fakeFetch,
  );

  assertEquals(calls, 2);
  assertEquals(events.at(-1)?.type, 'error');
});

Deno.test('a 400 naming a non-droppable field is terminal', async () => {
  // `tools` changes semantics - silently dropping it would answer the
  // turn without the toolbox. Must surface as an error instead.
  let calls = 0;
  const fakeFetch = ((_url: string | URL | Request) => {
    calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: "Extra inputs are not permitted, field: 'tools'",
          request_id: 'req-test',
        }),
        { status: 400 },
      ),
    );
  }) as typeof fetch;

  const events = await collect(
    {
      model: 'zai-org-glm-5-2',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
    },
    fakeFetch,
  );

  assertEquals(calls, 1);
  assertEquals(events.at(-1)?.type, 'error');
});
