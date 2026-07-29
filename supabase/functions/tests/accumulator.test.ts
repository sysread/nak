// Unit coverage for the distill-then-act accumulator
// (venice/agents/_accumulator.ts): the token estimate + fits-direct
// gate, the chunker's whole-block / hard-split behavior, message
// rendering (tool-traffic excerpting), the distill loop's buffer
// threading, the context-length backoff, and the empty-completion
// guard. All offline - the completion seam is scripted, no network.

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import {
  __test,
  distillTranscript,
  estimateWireTokens,
  isContextLengthError,
  renderDistilledNotesBlock,
  transcriptFitsDirect,
  WORKING_CONTEXT_TOKENS,
} from '../venice/agents/_accumulator.ts';
import type { VeniceWireMessage } from '../venice/agents/_recall_helpers.ts';
import type { ToolCompletionResult } from '../venice/tools/_venice_complete.ts';

const { nextChunk, renderMessage, TOOL_RESULT_EXCERPT_CHARS } = __test;

function completion(partial: Partial<ToolCompletionResult>): ToolCompletionResult {
  return {
    text: '',
    reasoning: '',
    citations: [],
    finishReason: 'stop',
    usage: null,
    toolCalls: [],
    ...partial,
  };
}

const CTX_ERROR = new Error(
  "Venice chat/completions 400: {\"error\":{\"message\":\"This model's maximum context length is 163840 tokens.",
);

Deno.test('isContextLengthError matches the upstream sentinel and nothing else', () => {
  assertEquals(isContextLengthError(CTX_ERROR), true);
  assertEquals(isContextLengthError(new Error('Venice chat/completions 500: gateway error')), false);
  assertEquals(
    isContextLengthError(
      new Error('Venice chat/completions 400: {"error":"Input text data may contain inappropriate content."}'),
    ),
    false,
  );
  assertEquals(isContextLengthError('maximum context length'), false); // not an Error
  assertEquals(isContextLengthError(null), false);
});

Deno.test('estimateWireTokens counts content plus tool_calls JSON', () => {
  const messages: VeniceWireMessage[] = [
    { role: 'user', content: 'a'.repeat(400) },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }],
    },
  ];
  const tokens = estimateWireTokens(messages);
  // 400 chars of content plus the tool_calls JSON, at 4 chars/token.
  const toolJson = JSON.stringify(messages[1].tool_calls).length;
  assertEquals(tokens, Math.ceil((400 + toolJson) / 4));
});

Deno.test('transcriptFitsDirect gates on the working context window', () => {
  const small: VeniceWireMessage[] = [{ role: 'user', content: 'hi' }];
  assertEquals(transcriptFitsDirect(small), true);
  const big: VeniceWireMessage[] = [
    { role: 'user', content: 'x'.repeat((WORKING_CONTEXT_TOKENS + 1) * 4) },
  ];
  assertEquals(transcriptFitsDirect(big), false);
});

Deno.test('nextChunk takes whole blocks up to the budget', () => {
  const { chunk, consumed, remainder } = nextChunk(['aaaa', 'bbbb', 'cccc'], 10);
  // 4 + 1 + 4 + 1 = 10 fits two blocks; the third would overflow.
  assertEquals(consumed, 2);
  assertEquals(chunk, 'aaaa\nbbbb');
  assertEquals(remainder, null);
});

Deno.test('nextChunk hard-splits a single oversized block and returns the tail', () => {
  const { chunk, consumed, remainder } = nextChunk(['x'.repeat(25), 'next'], 10);
  assertEquals(consumed, 1);
  assertEquals(chunk, 'x'.repeat(10));
  assertEquals(remainder, 'x'.repeat(15));
});

Deno.test('renderMessage keeps prose whole and excerpts tool traffic', () => {
  const prose = renderMessage({ role: 'user', content: 'tell me about my dog' });
  assertEquals(prose, '[user]\ntell me about my dog');

  const bigResult = renderMessage({
    role: 'tool',
    content: 'r'.repeat(TOOL_RESULT_EXCERPT_CHARS + 500),
    name: 'web_search',
  });
  assertStringIncludes(bigResult, '[tool result (web_search)]');
  assertStringIncludes(bigResult, '500 more chars omitted');

  const withCalls = renderMessage({
    role: 'assistant',
    content: 'checking',
    tool_calls: [
      { id: '1', type: 'function', function: { name: 'wiki_search', arguments: '{"query":"dog"}' } },
    ],
  });
  assertStringIncludes(withCalls, '(called wiki_search with {"query":"dog"})');
});

Deno.test('distillTranscript threads the notes buffer across chunks', async () => {
  // Two blocks sized so each fills most of a chunk budget - forces two
  // distill passes with the first pass's notes visible to the second.
  const blockChars = (WORKING_CONTEXT_TOKENS - 20_000) * 4;
  const messages: VeniceWireMessage[] = [
    { role: 'user', content: 'a'.repeat(blockChars) },
    { role: 'user', content: 'b'.repeat(blockChars) },
  ];
  const seenNotes: string[] = [];
  let pass = 0;
  const notes = await distillTranscript({
    apiKey: 'k',
    model: 'm',
    messages,
    focus: 'FOCUS-MARKER',
    // deno-lint-ignore require-await
    complete: async (opts) => {
      pass += 1;
      const system = String(opts.messages[0].content);
      assertStringIncludes(system, 'FOCUS-MARKER');
      const user = String(opts.messages[1].content);
      seenNotes.push(user.split('# Next transcript chunk')[0]);
      return completion({ text: `NOTES-${pass}` });
    },
  });
  assertEquals(pass, 2);
  assertEquals(notes, 'NOTES-2');
  assertStringIncludes(seenNotes[0], '(none yet - this is the first chunk)');
  // Pass 2 builds on pass 1's notes, not on a reset buffer.
  assertStringIncludes(seenNotes[1], 'NOTES-1');
});

Deno.test('distillTranscript backs off the chunk budget on a context-length rejection', async () => {
  const messages: VeniceWireMessage[] = [
    { role: 'user', content: 'z'.repeat(WORKING_CONTEXT_TOKENS * 4 * 2) },
  ];
  const chunkSizes: number[] = [];
  let first = true;
  const notes = await distillTranscript({
    apiKey: 'k',
    model: 'm',
    messages,
    focus: 'f',
    // deno-lint-ignore require-await
    complete: async (opts) => {
      const user = String(opts.messages[1].content);
      chunkSizes.push(user.length);
      if (first) {
        first = false;
        throw CTX_ERROR;
      }
      return completion({ text: 'ok' });
    },
  });
  assertEquals(notes, 'ok');
  // The retry after the rejection sent a strictly smaller chunk.
  assertEquals(chunkSizes.length >= 2, true);
  assertEquals(chunkSizes[1] < chunkSizes[0], true);
});

Deno.test('distillTranscript gives up when backoff hits the floor', async () => {
  const messages: VeniceWireMessage[] = [
    { role: 'user', content: 'z'.repeat(WORKING_CONTEXT_TOKENS * 4) },
  ];
  let calls = 0;
  await assertRejects(
    () =>
      distillTranscript({
        apiKey: 'k',
        model: 'm',
        messages,
        focus: 'f',
        // deno-lint-ignore require-await
        complete: async () => {
          calls += 1;
          throw CTX_ERROR;
        },
      }),
    Error,
    'maximum context length',
  );
  // Fractions tried: 1.0, 0.8, 0.6 - then 0.4 would cross the floor,
  // so the third rejection surfaces.
  assertEquals(calls, 3);
});

Deno.test('distillTranscript rejects an empty distill pass instead of wiping the notes', async () => {
  const messages: VeniceWireMessage[] = [{ role: 'user', content: 'hello' }];
  await assertRejects(
    () =>
      distillTranscript({
        apiKey: 'k',
        model: 'm',
        messages,
        focus: 'f',
        // A truncated reasoning pass: the whole output budget went to
        // thinking and content came back empty.
        // deno-lint-ignore require-await
        complete: async () => completion({ text: '', finishReason: 'length' }),
      }),
    Error,
    'finish_reason=length',
  );
});

Deno.test('renderDistilledNotesBlock wraps the notes and names them a distillation', () => {
  const block = renderDistilledNotesBlock('THE NOTES');
  assertStringIncludes(block, '<conversation_notes>');
  assertStringIncludes(block, 'THE NOTES');
  assertStringIncludes(block, 'too large to include verbatim');
  assertStringIncludes(block, '</conversation_notes>');
});
