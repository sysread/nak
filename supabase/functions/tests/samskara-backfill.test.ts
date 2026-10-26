// Samskara evidence-backfill worker - the pure-logic pin. The worker's
// IO (claim RPC, candidates RPC, ledger writes, fold) is exercised by
// docs/qa/use-cases/samskara-backfill.md; what a unit test can pin
// without a database is the prompt contract (no provenance disclosure,
// single-prediction framing, the shared two-step machinery) and the
// exchange-slice boundary math.
import { assertEquals } from 'jsr:@std/assert';
import {
  BACKFILL_FRAMING,
  exchangeSliceBounds,
  __test,
} from '../venice/agents/samskara_backfill.ts';
import { buildVerdictRequest } from '../venice/agents/samskara_evaluation.ts';
import type { StoredMessage } from '../venice/agents/_recall_helpers.ts';

const { JUDGE_SYSTEM_PROMPT } = __test;

// --- prompt contract ---------------------------------------------------------

Deno.test('backfill system prompt never discloses live/quarantine/backfill provenance', () => {
  // A provenance hint risks a leniency or harshness anchor (plan
  // decision 6): the judge must see only the prediction and the
  // transcript.
  for (const word of ['live', 'quarantine', 'backfill', 'new', 'warm']) {
    assertEquals(
      JUDGE_SYSTEM_PROMPT.toLowerCase().includes(word),
      false,
      `system prompt must not contain "${word}"`,
    );
  }
  // And the framing that replaces the live judge's "were live" line
  // carries the same discipline.
  assertEquals(BACKFILL_FRAMING.toLowerCase().includes('live'), false);
  assertEquals(BACKFILL_FRAMING.toLowerCase().includes('backfill'), false);
});

Deno.test('backfill framing keeps the shared two-step machinery intact', () => {
  const request = buildVerdictRequest([{ tag: 'p1', text: 'the prediction' }], BACKFILL_FRAMING);
  // The framing sentence replaced, everything the live judge calibrated
  // (the two-step engagement gate, the four verdicts, the JSON contract)
  // still present - drift here is what the 92.5% held-rate incident
  // punished.
  assertEquals(request.includes('live during the conversation above'), false);
  assertEquals(request.includes(BACKFILL_FRAMING), true);
  assertEquals(request.includes('p1: the prediction'), true);
  assertEquals(request.includes('"not-engaged"'), true);
  assertEquals(request.includes('"not-borne-out"'), true);
  assertEquals(request.includes('"held"'), true);
  assertEquals(request.includes('"contradicted"'), true);
  assertEquals(request.includes('STEP 1'), true);
  assertEquals(request.includes('STEP 2'), true);
});

Deno.test('the live judge framing still names fired predictions (parameter default unchanged)', () => {
  const request = buildVerdictRequest([{ tag: 'p1', text: 'the prediction' }]);
  assertEquals(request.includes('were live during the conversation above'), true);
});

// --- exchange-slice bounds ---------------------------------------------------

function thread(rounds: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push({ id: `u${i}`, role: 'user', content: `question ${i}`, tool_calls: null, tool_call_id: null, name: null });
    out.push({ id: `a${i}`, role: 'assistant', content: `answer ${i}`, tool_calls: null, tool_call_id: null, name: null });
  }
  return out;
}

Deno.test('slice bounds cover the target exchange plus one adjacent on each side', () => {
  const msgs = thread(5); // u0 a0 u1 a1 u2 a2 u3 a3 u4 a4
  // Target = middle round (u2): slice is [u1 .. a3] = rounds 1, 2, 3.
  const b = exchangeSliceBounds(msgs, 'u2');
  assertEquals(b, { start: 2, end: 8 });
  assertEquals(msgs.slice(b!.start, b!.end).map((m) => m.id), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
});

Deno.test('slice bounds clamp at the thread edges', () => {
  const msgs = thread(3);
  // First round: no left neighbour.
  assertEquals(exchangeSliceBounds(msgs, 'u0'), { start: 0, end: 4 });
  // Last round: no right neighbour.
  assertEquals(exchangeSliceBounds(msgs, 'u2'), { start: 2, end: 6 });
});

Deno.test('slice bounds on a single-round thread are the whole thread', () => {
  const msgs = thread(1);
  assertEquals(exchangeSliceBounds(msgs, 'u0'), { start: 0, end: 2 });
});

Deno.test('slice bounds return null for a deleted target message', () => {
  const msgs = thread(3);
  assertEquals(exchangeSliceBounds(msgs, 'u99'), null);
});

Deno.test('slice bounds key on USER messages only (a tool row id never matches)', () => {
  const msgs: StoredMessage[] = [
    { id: 'u0', role: 'user', content: 'q0', tool_calls: null, tool_call_id: null, name: null },
    { id: 'a0', role: 'assistant', content: 'a0', tool_calls: null, tool_call_id: null, name: null },
    { id: 't0', role: 'tool', content: 't', tool_calls: null, tool_call_id: null, name: null },
    { id: 'u1', role: 'user', content: 'q1', tool_calls: null, tool_call_id: null, name: null },
    { id: 'a1', role: 'assistant', content: 'a1', tool_calls: null, tool_call_id: null, name: null },
  ];
  assertEquals(exchangeSliceBounds(msgs, 't0'), null);
  // The target user round's exchange spans the interleaved tool row.
  assertEquals(exchangeSliceBounds(msgs, 'u1'), { start: 0, end: 5 });
});
