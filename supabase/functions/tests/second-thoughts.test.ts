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

const { parseVerdict, serializeExchange } = __test;

// --- parseVerdict -------------------------------------------------------

Deno.test('parseVerdict accepts a clean conviction verdict', () => {
  const v = parseVerdict('{"disposition":"conviction","note":""}');
  assertEquals(v, { disposition: 'conviction', note: '' });
});

Deno.test('parseVerdict accepts each doubt disposition with a note', () => {
  for (const d of ['hedge', 'reframe', 'correct'] as const) {
    const v = parseVerdict(`{"disposition":"${d}","note":"something felt off"}`);
    assertEquals(v?.disposition, d);
    assertEquals(v?.note, 'something felt off');
  }
});

Deno.test('parseVerdict strips a markdown code fence the model may add', () => {
  const raw = '```json\n{"disposition":"hedge","note":"maybe overstated"}\n```';
  const v = parseVerdict(raw);
  assertEquals(v?.disposition, 'hedge');
  assertEquals(v?.note, 'maybe overstated');
});

Deno.test('parseVerdict trims and length-caps the note', () => {
  const long = 'x'.repeat(2000);
  const v = parseVerdict(`{"disposition":"correct","note":"  ${long}  "}`);
  assert(v !== null);
  // Trimmed of surrounding whitespace, then capped well under 2000.
  assert(v!.note.length <= 800);
  assert(v!.note.startsWith('x'));
});

Deno.test('parseVerdict rejects an unknown disposition', () => {
  assertEquals(parseVerdict('{"disposition":"panic","note":"x"}'), null);
});

Deno.test('parseVerdict rejects non-JSON', () => {
  assertEquals(parseVerdict('I think the answer was fine, honestly.'), null);
});

Deno.test('parseVerdict rejects a missing disposition', () => {
  assertEquals(parseVerdict('{"note":"x"}'), null);
});

Deno.test('parseVerdict defaults a missing note to empty string', () => {
  const v = parseVerdict('{"disposition":"conviction"}');
  assertEquals(v, { disposition: 'conviction', note: '' });
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
