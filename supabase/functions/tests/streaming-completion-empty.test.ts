// Offline unit test for the empty-stream forensics line in
// getStreamingCompletion's SSE reader. A stream that ends cleanly
// (finish_reason=stop, [DONE] sentinel) having yielded no text, no
// reasoning, and no tool call must log a bounded sample of the RAW
// frames plus the usage epilogue's completion_tokens - that line is
// the only evidence separating "the model sent zero tokens" from
// "the model sent a delta shape the parser does not read". Fake
// fetch, zero network; console.warn is captured for the assertion.
import { assert, assertEquals } from '@std/assert';
import { getStreamingCompletion } from '../venice/getStreamingCompletion.ts';
import type { CompletionEvent, StreamSignal } from '../_shared/venice-stream.ts';

// Every content-bearing frame carries an empty delta; the usage
// epilogue reports tokens the parser never surfaced. This is the shape
// a delta field the parser ignores would produce.
const EMPTY_SSE = [
  'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{"mystery_field":"..."},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":7,"total_tokens":17}}',
  'data: [DONE]',
  '',
].join('\n\n');

const HAPPY_SSE = [
  'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  '',
].join('\n\n');

async function collect(
  sse: string,
): Promise<{ events: Array<CompletionEvent | StreamSignal>; warnings: string[] }> {
  const fakeFetch = ((_url: string | URL | Request) =>
    Promise.resolve(new Response(sse, { status: 200 }))) as typeof fetch;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  const events: Array<CompletionEvent | StreamSignal> = [];
  try {
    const ctl = new AbortController();
    for await (const ev of getStreamingCompletion({
      apiKey: 'k',
      body: { model: 'm', messages: [{ role: 'user', content: 'ping' }] },
      signal: ctl.signal,
      fetchImpl: fakeFetch,
      guardsOverride: [],
    })) {
      events.push(ev);
    }
  } finally {
    console.warn = originalWarn;
  }
  return { events, warnings };
}

Deno.test('an empty stream logs raw frames and completion_tokens', async () => {
  const { events, warnings } = await collect(EMPTY_SSE);
  assert(!events.some((e) => e.type === 'response_text'));
  assert(!events.some((e) => e.type === 'reasoning_text'));
  assert(!events.some((e) => e.type === 'tool_call_request'));
  assertEquals(events.at(-1)?.type, 'DONE');

  const line = warnings.find((w) => w.includes('[streamFromVenice] empty stream'));
  assert(line, `expected an empty-stream warning, got ${JSON.stringify(warnings)}`);
  assert(line.includes('completion_tokens=7'), line);
  assert(line.includes('finishReason=stop'), line);
  // The raw frame is what makes the line useful: the unread field
  // name survives verbatim so the fix can target it.
  assert(line.includes('mystery_field'), line);
});

Deno.test('a stream with text logs no empty-stream warning', async () => {
  const { events, warnings } = await collect(HAPPY_SSE);
  assert(events.some((e) => e.type === 'response_text'));
  assert(!warnings.some((w) => w.includes('empty stream')), JSON.stringify(warnings));
});
