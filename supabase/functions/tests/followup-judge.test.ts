// Unit coverage for the follow-up resolution judge's pure parts (Deno
// island): the /decisions body builder (one noul per open follow-up,
// the outcome bar in the instructions), the answer coercion (fail-
// open per id), the prompt composer (byte-stability on fail-open;
// the judge block placed BEFORE the single-word-reply contract), and
// the skip predicate. The claim/save/judge glue is uncovered by
// convention (offline island, no client stubs) - the wiring is
// exercised in live QA.
import { assert, assertEquals } from '@std/assert';
import { __test } from '../venice/agents/reflection.ts';

const {
  REFLECTION_PROMPT,
  REFLECTION_PROMPT_BODY,
  SINGLE_WORD_REPLY_LINE,
  shouldJudgeFollowups,
  buildJudgeRequest,
  coerceJudgeVerdicts,
  composeReflectionPrompt,
} = __test;

const F1 = { id: 'f1', question: 'Ask how the lasagna turned out', context: 'they planned lasagna' };
const F2 = { id: 'f2', question: 'How did Thursday\'s meeting go?', context: '' };

function payloadFor(entries: Array<{ id: string; p: number }>): unknown {
  const answers: Record<string, unknown> = {};
  for (const e of entries) answers[`resolved-${e.id}`] = { noul: e.p };
  return { answers };
}

Deno.test('the judge rides the decision tier', () => {
  const body = buildJudgeRequest([F1], '<transcript>t</transcript>');
  assertEquals(body.model, 'clef-api');
});

Deno.test('body shape: fenced transcript state, one noul per follow-up, question verbatim', () => {
  const body = buildJudgeRequest([F1, F2], '<transcript>...</transcript>');
  const state = body.state as {
    transcript: string;
    followups: Array<{ id: string; question: string; context: string }>;
  };
  assert(state.transcript.includes('<transcript>'));
  assertEquals(
    state.followups.map((f) => [f.id, f.question, f.context]),
    [
      [F1.id, F1.question, F1.context],
      [F2.id, F2.question, F2.context],
    ],
  );
  const questions = body.questions as Record<string, { type: string; instructions: string }>;
  assertEquals(Object.keys(questions).length, 2);
  for (const f of [F1, F2]) {
    assertEquals(questions[`resolved-${f.id}`].type, 'noul');
    assert(
      questions[`resolved-${f.id}`].instructions.includes(f.question),
      `the question text must ride the instruction for ${f.id}`,
    );
  }
});

Deno.test('the outcome bar (reported how it went) rides the instructions', () => {
  const body = buildJudgeRequest([F1], 't');
  const q = (body.questions as Record<string, { instructions: string }>)[`resolved-${F1.id}`];
  assert(/reported how it went/i.test(q.instructions));
  assert(/not an outcome/.test(q.instructions));
});

Deno.test('coercion reads usable answers and drops drift per id', () => {
  const ids = new Set([F1.id, F2.id]);
  const m = coerceJudgeVerdicts(payloadFor([{ id: F1.id, p: 0.87 }, { id: F2.id, p: 0.05 }]), ids);
  assertEquals(m!.get(F1.id), 0.87);
  assertEquals(m!.get(F2.id), 0.05);

  // A missing or malformed answer drops that id alone.
  const missing = payloadFor([{ id: F1.id, p: 0.5 }]) as { answers: Record<string, unknown> };
  assertEquals(coerceJudgeVerdicts(missing, ids)!.size, 1);
  const malformed = payloadFor([{ id: F1.id, p: 0.5 }, { id: F2.id, p: 0.5 }]) as {
    answers: Record<string, unknown>;
  };
  malformed.answers[`resolved-${F2.id}`] = { noul: 'high' };
  assertEquals(coerceJudgeVerdicts(malformed, ids)!.size, 1);

  // Clamped to [0,1].
  const clamped = coerceJudgeVerdicts(payloadFor([{ id: F1.id, p: 1.5 }]), ids);
  assertEquals(clamped!.get(F1.id), 1);
});

Deno.test('coercion returns null when nothing is usable', () => {
  const ids = new Set([F1.id]);
  for (const bad of [null, 42, 'x', {}, { answers: null }]) {
    assertEquals(coerceJudgeVerdicts(bad, ids), null, `payload ${JSON.stringify(bad)}`);
  }
  assertEquals(coerceJudgeVerdicts({ answers: {} }, ids), null);
});

Deno.test('fail-open composes the prompt byte-identical to the static one', () => {
  assertEquals(composeReflectionPrompt(null), REFLECTION_PROMPT);
  assertEquals(composeReflectionPrompt(new Map()), REFLECTION_PROMPT);
  // The split is exact: body + line == the composed whole.
  assertEquals(REFLECTION_PROMPT_BODY + SINGLE_WORD_REPLY_LINE, REFLECTION_PROMPT);
});

Deno.test('the judge block sits between the body and the single-word contract', () => {
  const composed = composeReflectionPrompt(new Map([[F1.id, 0.87]]));
  const blockIdx = composed.indexOf('<followup_judge>');
  const lineIdx = composed.indexOf('When you have nothing more to write, reply with a single word');
  assert(blockIdx > 0, 'the block is present');
  assert(
    blockIdx > REFLECTION_PROMPT_BODY.length - 1 && blockIdx < lineIdx,
    'the block rides after the workflow body and BEFORE the discard-your-reply line',
  );
  assert(composed.endsWith(SINGLE_WORD_REPLY_LINE));
  assert(composed.includes('likely resolved here (p=0.87)'));
  assert(composed.includes('EVIDENCE, not a verdict'));
  assert(composed.includes('needs your\nown one-line resolution'));
});

Deno.test('a low probability reads as not-resolved and changes nothing', () => {
  const composed = composeReflectionPrompt(new Map([[F2.id, 0.05]]));
  assert(composed.includes('not resolved here (p=0.05)'));
});

Deno.test('skip predicate: needs a non-empty slice AND an open follow-up', () => {
  assertEquals(shouldJudgeFollowups(0, 3), false);
  assertEquals(shouldJudgeFollowups(5, 0), false);
  assertEquals(shouldJudgeFollowups(5, 2), true);
});
