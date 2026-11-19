// Pure guards for the second-thoughts reviewer's parse + serialize
// surface (supabase/functions/venice/agents/second_thoughts.ts). These
// pin the two things a fast model can trip on: a verdict that must be
// rejected (unknown disposition, non-JSON, missing field) and the
// fenced-transcript serialization the reviewer sees.
//
// Pure: every assertion drives the exported __test surface; no DB, no
// network, no Supabase env.

import { assert, assertEquals } from '@std/assert';
import { __test } from '../venice/agents/second_thoughts.ts';

const {
  buildVerdictRequest,
  coerceDisposition,
  sanitizeNote,
  serializeExchange,
  serializeBackground,
  verifiedQuotes,
} = __test;

// --- buildVerdictRequest / coerceDisposition / sanitizeNote --------------

Deno.test('buildVerdictRequest carries the fences as state with the reviewer brief', () => {
  const body = buildVerdictRequest(
    [
      { id: 'u1', role: 'user' as const, content: 'is Bristol in Devon?', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
      { id: 'a1', role: 'assistant' as const, content: 'Yes, Bristol is a city in Devon.', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    ],
    '<conversation_so_far>\n[user]\nwhat do you know about england\n</conversation_so_far>',
  );
  assertEquals(body.model, 'clef-api');
  const state = body.state as Record<string, unknown>;
  // The fenced exchange + background ride as data.
  assert((state.exchange_under_review as string).includes('is Bristol in Devon?'));
  assert((state.conversation_so_far as string).includes('what do you know about england'));
  // The verdict-shaping rules ride the state + question (D5): the
  // grounding discipline, the provenance rules, and the instruction to
  // trust the serializer's URL/quote lines.
  const brief = state.reviewer_brief as string;
  assert(brief.includes('Grounding check'));
  assert(brief.includes('Provenance check'));
  assert(brief.includes('quotations confirmed verbatim'));
  const questions = body.questions as Record<string, Record<string, unknown>>;
  const q = questions.disposition;
  assertEquals(q.type, 'choice');
  assert((q.instructions as string).includes('conviction'));
  const criteria = q.criteria as Record<string, string>;
  for (const d of ['conviction', 'hedge', 'reframe', 'correct']) {
    assert(typeof criteria[d] === 'string' && criteria[d].length > 0);
  }
});

Deno.test('buildVerdictRequest drops the background then tightens tool results on overflow', () => {
  // A tool result big enough that 4k-capped serialization + the
  // background blows the 96k budget.
  const big = 'x'.repeat(200_000);
  const rows = [
    { id: 'u1', role: 'user' as const, content: 'summarize', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    { id: 't1', role: 'tool' as const, content: big, reasoning: null, tool_calls: null, tool_call_id: null, name: 'research_docs' },
    { id: 'a1', role: 'assistant' as const, content: 'done', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
  ];
  const bg = '<conversation_so_far>\n[user]\nold topic\n</conversation_so_far>';

  const roomy = buildVerdictRequest(rows, bg);
  let state = roomy.state as Record<string, unknown>;
  // Under the budget with one 4k-capped tool row? 200k > 4k cap, so the
  // exchange is small - the background survives.
  assert(state.conversation_so_far !== undefined);

  // Force overflow: the budget guard must drop the background first,
  // then tighten the tool cap - the row structure survives every pass.
  const manyRows = Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`,
    role: 'tool' as const,
    content: big,
    reasoning: null,
    tool_calls: null,
    tool_call_id: null,
    name: 'research_docs',
  }));
  const overflow = buildVerdictRequest(
    [{ id: 'u1', role: 'user' as const, content: 'q', reasoning: null, tool_calls: null, tool_call_id: null, name: null }, ...manyRows],
    bg,
  );
  state = overflow.state as Record<string, unknown>;
  // The background was the first thing dropped.
  assertEquals(state.conversation_so_far, undefined);
  // The exchange kept its structure (fence + rows) under the budget.
  const exchange = state.exchange_under_review as string;
  assert(exchange.length <= 96_000 + 2000);
  assert(exchange.includes('<exchange_under_review>'));
  assert(exchange.includes('q'));
  // Tool bodies thinned to the last pass cap.
  assert(exchange.includes('...[truncated]'));
});

Deno.test('coerceDisposition reads the choice answer with confidence', () => {
  const v = coerceDisposition({
    answers: {
      disposition: {
        type: 'choice',
        choice: 'hedge',
        probabilities: { conviction: 0.1, hedge: 0.85, reframe: 0.05, correct: 0 },
        confidence: 0.8,
      },
    },
  });
  assertEquals(v, { disposition: 'hedge', confidence: 0.8 });
});

Deno.test('coerceDisposition fails open to null on any drift', () => {
  assertEquals(coerceDisposition({ answers: { disposition: { choice: 'panic', confidence: 1 } } }), null);
  assertEquals(coerceDisposition({ answers: { disposition: {} } }), null);
  assertEquals(coerceDisposition({ answers: 'garbage' }), null);
  assertEquals(coerceDisposition(null), null);
});

Deno.test('sanitizeNote caps and passes clean prose through', () => {
  assertEquals(sanitizeNote('  I said it keeps well, but I am not sure about the dairy.  '), 'I said it keeps well, but I am not sure about the dairy.');
  const long = 'x'.repeat(2000);
  assert(sanitizeNote(long).length <= 800);
});

Deno.test('sanitizeNote rejects the known leak shapes to an empty note', () => {
  // A thinking pass riding the content channel.
  assertEquals(sanitizeNote('<think>the answer was wrong</think>I doubt it.'), '');
  // A prompt echo (the compound-summary guard's signature-phrase shape).
  assertEquals(sanitizeNote('You are the quiet voice of second thoughts.'), '');
  // A list-line reasoning dump.
  assertEquals(sanitizeNote('I doubt it.\n- point one\n- point two'), '');
});

// --- serializeExchange --------------------------------------------------

Deno.test('serializeExchange fences the exchange and labels roles', () => {
  const out = serializeExchange([
    { id: '1', role: 'user', content: 'do fires threaten the city?', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    { id: '2', role: 'assistant', content: 'No immediate threat.', reasoning: 'they have asthma, so I will add a precaution', tool_calls: null, tool_call_id: null, name: null },
  ]);
  assert(out.startsWith('<exchange_under_review>'));
  assert(out.trimEnd().endsWith('</exchange_under_review>'));
  assert(out.includes('[user]'));
  assert(out.includes('[assistant]'));
  // The assistant's reasoning rides along so the reviewer can weigh the
  // stated justification, not just the prose.
  assert(out.includes('(reasoning)'));
  assert(out.includes('they have asthma'));
});

Deno.test('serializeExchange renders tool calls and truncates a huge tool result', () => {
  const big = 'y'.repeat(10000);
  const out = serializeExchange([
    { id: '1', role: 'user', content: 'look it up', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    {
      id: '2',
      role: 'assistant',
      content: '',
      reasoning: null,
      tool_calls: [{ function: { name: 'web_search', arguments: '{"query":"x"}' } }],
      tool_call_id: null,
      name: null,
    },
    { id: '3', role: 'tool', content: big, reasoning: null, tool_calls: null, tool_call_id: 'c1', name: 'web_search' },
  ]);
  assert(out.includes('(tool calls)'));
  assert(out.includes('web_search('));
  assert(out.includes('[tool result: web_search]'));
  assert(out.includes('...[truncated]'));
  // The 10k body must not survive whole in the transcript.
  assert(!out.includes(big));
});

Deno.test('serializeExchange surfaces a tool URL even when it sits past the truncation point', () => {
  // The exact production failure: a web_search citation URL deep in a
  // long result got cut off, so the reviewer wrongly flagged a
  // legitimately-cited URL as fabricated. The URL must survive.
  const url = 'https://github.com/anomalyco/opencode/issues/14888';
  const longResult =
    `{"answer":"...","citations":[${'{"snippet":"' + 'z'.repeat(9000) + '"},'}` +
    `{"url":"${url}"}]}`;
  const out = serializeExchange([
    { id: '1', role: 'user', content: 'does it have an issue?', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    // Assistant prose deliberately does NOT contain the URL, so the URL
    // can only reach the transcript via the tool-result surfacing.
    { id: '2', role: 'assistant', content: 'Yes, there is an open issue.', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    { id: '3', role: 'tool', content: longResult, reasoning: null, tool_calls: null, tool_call_id: 'c1', name: 'web_search' },
  ]);
  assert(out.includes('...[truncated]'), 'the long body should truncate');
  // Even though the URL is far past the 4k cutoff, it is surfaced.
  assert(out.includes('source URLs this tool returned'));
  assert(out.includes(url), 'the cited URL must survive truncation');
});

// --- serializeBackground ------------------------------------------------

Deno.test('serializeBackground fences prior turns separately from the review', () => {
  const out = serializeBackground([
    { id: '1', role: 'user', content: 'I keep bees on the north field', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    { id: '2', role: 'assistant', content: 'Three hives is a good start.', reasoning: 'irrelevant here', tool_calls: null, tool_call_id: null, name: null },
  ]);
  assert(out.startsWith('<conversation_so_far>'));
  assert(out.trimEnd().endsWith('</conversation_so_far>'));
  assert(out.includes('I keep bees'));
  // Background is WHAT was discussed, not how the answer was reached -
  // reasoning stays out so the block cannot be mistaken for a second
  // exchange to review.
  assert(!out.includes('irrelevant here'));
});

Deno.test('serializeBackground clips a long prior message', () => {
  const long = 'q'.repeat(5000);
  const out = serializeBackground([
    { id: '1', role: 'assistant', content: long, reasoning: null, tool_calls: null, tool_call_id: null, name: null },
  ]);
  assert(out.includes('...[clipped]'));
  assert(!out.includes(long));
});

Deno.test('serializeBackground emits nothing on a first turn', () => {
  // No history means the prompt must be byte-identical to what it was
  // before background existed - the caller skips the block entirely.
  assertEquals(serializeBackground([]), '');
});

// --- quotation provenance -----------------------------------------------

Deno.test('serializeExchange confirms a quote that lives past the truncation point', () => {
  // The sibling of the surfaced-URL case: the assistant quotes a passage
  // sitting deep in a 14k web_search result. The body is cut at 4k, so
  // without the confirmation line the reviewer sees a quotation it
  // cannot find and reports correctly-sourced text as invented.
  const quote = 'the caldera has been quiet since the 1918 eruption';
  const longResult = `{"snippet":"${'z'.repeat(9000)}","body":"${quote}"}`;
  const out = serializeExchange([
    { id: '1', role: 'user', content: 'what does the survey say?', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    { id: '2', role: 'assistant', content: `The survey notes "${quote}".`, reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    { id: '3', role: 'tool', content: longResult, reasoning: null, tool_calls: null, tool_call_id: 'c1', name: 'web_search' },
  ]);
  assert(out.includes('...[truncated]'), 'the long body should truncate');
  assert(out.includes('quotations confirmed verbatim'));
  assert(out.includes(quote), 'the quote must survive truncation');
});

Deno.test('verifiedQuotes matches across whitespace rewrapping', () => {
  // Markdown prose rewraps; the tool payload keeps the original breaks.
  // Only whitespace is normalized - nothing looser, or the check would
  // start confirming quotes that were never returned.
  const found = verifiedQuotes([
    { id: '1', role: 'assistant', content: 'It said "a long enough phrase to check\nacross a line break".', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    { id: '2', role: 'tool', content: 'noise a long enough phrase to check across a line break noise', reasoning: null, tool_calls: null, tool_call_id: 'c1', name: 'web_search' },
  ]);
  assertEquals(found.length, 1);
});

Deno.test('verifiedQuotes ignores short quotes and unmatched ones', () => {
  const found = verifiedQuotes([
    // Too short to be evidence of anything - a coincidental match on a
    // scare-quoted term proves nothing.
    { id: '1', role: 'assistant', content: 'It is a "widget" per the docs.', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    // Long enough, but absent from the tool result. NOT reported: an
    // unmatched quote is not evidence of fabrication either (the
    // assistant may be quoting the user), so the list stays empty.
    { id: '2', role: 'assistant', content: 'The report claims "something never returned by any tool at all".', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    { id: '3', role: 'tool', content: 'a widget is a thing', reasoning: null, tool_calls: null, tool_call_id: 'c1', name: 'web_search' },
  ]);
  assertEquals(found, []);
});

Deno.test('verifiedQuotes returns nothing when the turn used no tools', () => {
  assertEquals(
    verifiedQuotes([
      { id: '1', role: 'assistant', content: 'As Kennedy put it, "ask not what your country can do for you".', reasoning: null, tool_calls: null, tool_call_id: null, name: null },
    ]),
    [],
  );
});

Deno.test('serializeBackground carries earlier turns source URLs', () => {
  // A citation whose search ran two turns ago has no tool result in the
  // slice at all; the URL line is the only provenance that survives.
  const url = 'https://example.gov/survey/2026';
  const out = serializeBackground(
    [{ id: '1', role: 'assistant', content: 'The survey backs that up.', reasoning: null, tool_calls: null, tool_call_id: null, name: null }],
    [url],
  );
  assert(out.includes('source URLs tools returned earlier'));
  assert(out.includes(url));
});

Deno.test('serializeBackground omits the URL line when no earlier tool ran', () => {
  const out = serializeBackground(
    [{ id: '1', role: 'user', content: 'morning', reasoning: null, tool_calls: null, tool_call_id: null, name: null }],
    [],
  );
  assert(!out.includes('source URLs'));
});
