// Rendering + chunking guards for _shared/thread-transcript.ts.
//
// Pure: no DB, no network. The properties asserted here are the ones
// the rechunk unit and the chunk search RPC both assume.

import { assert, assertEquals } from '@std/assert';
import {
  CHUNK_RENDER_VERSION,
  chunkTranscript,
  EMBEDDING_MAX_INPUT_CHARS,
  renderMessage,
  type TranscriptMessage,
} from '../_shared/thread-transcript.ts';
import {
  EMBEDDING_CHARS_PER_TOKEN,
  EMBEDDING_INPUT_SAFETY_MARGIN,
  VENICE_EMBEDDING_MAX_INPUT_TOKENS,
} from '../_shared/backfill.ts';

function msg(over: Partial<TranscriptMessage> & { id: string }): TranscriptMessage {
  return {
    role: 'user',
    content: 'hello',
    tool_calls: null,
    name: null,
    ...over,
  };
}

// --- sizing constants -----------------------------------------------------

Deno.test('chunk budget stays under the model ceiling with margin to spare', () => {
  // The whole point of the margin is that the estimate can be wrong in
  // the direction of "more tokens than we thought" and still fit.
  const estimatedTokens = EMBEDDING_MAX_INPUT_CHARS / EMBEDDING_CHARS_PER_TOKEN;
  assert(estimatedTokens <= VENICE_EMBEDDING_MAX_INPUT_TOKENS);
  assertEquals(
    Math.round(estimatedTokens),
    Math.round(VENICE_EMBEDDING_MAX_INPUT_TOKENS * EMBEDDING_INPUT_SAFETY_MARGIN),
  );
});

Deno.test('chars-per-token divisor stays under the densest measured prose sample', () => {
  // Measured against bge-m3's reported prompt_tokens: tool-call JSON
  // came in at 2.24 chars/token and cooklang at 2.44. A divisor above
  // those would under-count tokens and overflow on ordinary threads.
  assert(EMBEDDING_CHARS_PER_TOKEN <= 2.24);
});

// --- rendering ------------------------------------------------------------

Deno.test('renderMessage prefixes the speaker so a question and its answer differ', () => {
  assertEquals(renderMessage(msg({ id: 'a', role: 'user', content: 'is it done?' })), 'user: is it done?');
  assertEquals(
    renderMessage(msg({ id: 'b', role: 'assistant', content: 'is it done?' })),
    'assistant: is it done?',
  );
});

Deno.test('renderMessage keeps tool-call arguments - they carry the search intent', () => {
  const rendered = renderMessage(
    msg({
      id: 'c',
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'x',
          type: 'function',
          function: { name: 'conversation_search', arguments: '{"query":"cider soak no lentils"}' },
        },
      ],
    }),
  );
  assert(rendered !== null);
  assert(rendered.includes('conversation_search'));
  assert(rendered.includes('cider soak no lentils'));
});

Deno.test('renderMessage keeps both the tool calls and the prose on one row', () => {
  const rendered = renderMessage(
    msg({
      id: 'd',
      role: 'assistant',
      content: 'let me look that up',
      tool_calls: [{ type: 'function', function: { name: 'recipe_get', arguments: '{}' } }],
    }),
  );
  assertEquals(rendered, 'assistant calls recipe_get({})\nassistant: let me look that up');
});

Deno.test('renderMessage does not index tool results at all', () => {
  // Tool results were 34.8% of the indexed corpus by character and made
  // 29% of chunks majority-machine-output. They describe whatever a tool
  // returned rather than what the conversation was about - one thread
  // about meatballs carried a chunk that was mostly a wiki dump about
  // brownies - and because every tool-using thread accumulates the same
  // JSON shapes, indexing them pulled unrelated conversations toward a
  // common region of the space.
  assertEquals(
    renderMessage(
      msg({ id: 'e', role: 'tool', name: 'conversation_search', content: 'x'.repeat(9000) }),
    ),
    null,
  );
  // Even a short, readable-looking one.
  assertEquals(
    renderMessage(msg({ id: 'e2', role: 'tool', name: 'recipe_get', content: 'sourdough' })),
    null,
  );
});

Deno.test('the render version is bumped whenever this module changes shape', () => {
  // The rechunk unit re-qualifies threads on message changes, which
  // cannot see an edit to the rendering rules. Without a bump, changing
  // what gets indexed leaves every existing thread on the old shape
  // forever. Version 2 is "tool result bodies dropped".
  assertEquals(CHUNK_RENDER_VERSION, 2);
});

Deno.test('renderMessage drops rows that carry nothing indexable', () => {
  assertEquals(renderMessage(msg({ id: 'f', content: '   ' })), null);
  assertEquals(renderMessage(msg({ id: 'g', role: 'tool', content: 'anything' })), null);
  assertEquals(renderMessage(msg({ id: 'h', content: '', tool_calls: [] })), null);
  // Malformed tool_calls must not fabricate an empty call line.
  assertEquals(renderMessage(msg({ id: 'i', content: '', tool_calls: [{ nope: 1 }] })), null);
});

// --- chunking -------------------------------------------------------------

Deno.test('chunkTranscript packs messages up to the budget and no further', () => {
  const messages = Array.from({ length: 10 }, (_, i) =>
    msg({ id: `m${i}`, content: 'a'.repeat(40) }),
  );
  const chunks = chunkTranscript(messages, 100);
  for (const c of chunks) assert(c.text.length <= 100);
  // Every message survives somewhere.
  const joined = chunks.map((c) => c.text).join('\n\n');
  assertEquals(joined.split('user: ').length - 1, 10);
});

Deno.test('chunk boundaries are stable as the thread grows', () => {
  // The rechunk unit re-embeds only what changed, which is only sound
  // if appending never renumbers or rewrites an earlier chunk. If this
  // breaks, every new message silently re-embeds the whole thread.
  const base = Array.from({ length: 12 }, (_, i) => msg({ id: `m${i}`, content: 'a'.repeat(40) }));
  const before = chunkTranscript(base, 100);
  const after = chunkTranscript([...base, msg({ id: 'new', content: 'b'.repeat(40) })], 100);

  assert(after.length >= before.length);
  // Every chunk except the previously-last one is byte-identical.
  for (let i = 0; i < before.length - 1; i++) {
    assertEquals(after[i].text, before[i].text);
    assertEquals(after[i].index, before[i].index);
    assertEquals(after[i].startMsgId, before[i].startMsgId);
    assertEquals(after[i].endMsgId, before[i].endMsgId);
  }
});

Deno.test('chunks carry the message range they cover, in order', () => {
  const messages = Array.from({ length: 6 }, (_, i) => msg({ id: `m${i}`, content: 'a'.repeat(40) }));
  const chunks = chunkTranscript(messages, 100);
  assertEquals(chunks[0].startMsgId, 'm0');
  for (let i = 0; i < chunks.length; i++) assertEquals(chunks[i].index, i);
  assertEquals(chunks[chunks.length - 1].endMsgId, 'm5');
});

Deno.test('an oversized single message is split rather than dropped', () => {
  const chunks = chunkTranscript([msg({ id: 'big', content: 'z'.repeat(500) })], 100);
  assert(chunks.length >= 5);
  for (const c of chunks) {
    assert(c.text.length <= 100);
    // A split message anchors to itself on both ends.
    assertEquals(c.startMsgId, 'big');
    assertEquals(c.endMsgId, 'big');
  }
  assertEquals(chunks.map((c) => c.index), chunks.map((_, i) => i));
});

Deno.test('an oversized message does not swallow its neighbours into its chunks', () => {
  const chunks = chunkTranscript(
    [
      msg({ id: 'before', content: 'a'.repeat(40) }),
      msg({ id: 'big', content: 'z'.repeat(300) }),
      msg({ id: 'after', content: 'c'.repeat(40) }),
    ],
    100,
  );
  assertEquals(chunks[0].startMsgId, 'before');
  assertEquals(chunks[0].endMsgId, 'before');
  assertEquals(chunks[chunks.length - 1].startMsgId, 'after');
});

Deno.test('chunkTranscript is empty for a thread with nothing indexable', () => {
  assertEquals(chunkTranscript([], 100), []);
  assertEquals(chunkTranscript([msg({ id: 'a', content: '' })], 100), []);
});

Deno.test('the real default budget fits a long ordinary turn in one chunk', () => {
  // Sanity that the derived constant is in a usable range - a budget
  // small enough to split every turn would shred retrieval context.
  const chunks = chunkTranscript([msg({ id: 'a', content: 'word '.repeat(1_000) })]);
  assertEquals(chunks.length, 1);
  assert(EMBEDDING_MAX_INPUT_CHARS > 10_000);
});
