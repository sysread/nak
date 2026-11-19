// Unit coverage for the intent employment judge's pure parts (Deno
// island): the /decisions body builder (question minting + the
// firewall framing), the transcript serializer (clips + caps), the
// answer coercion (the boolean cuts and the reaction gating), and the
// failure classifier (deterministic rejection vs transient). The
// claim/save glue is uncovered by convention (offline island, no
// client stubs) - the failure contract is exercised in live QA.
import { assert, assertEquals } from '@std/assert';
import { VeniceError } from '../_shared/venice.ts';
import { trimToCharBudget, type StoredMessage } from '../venice/agents/_recall_helpers.ts';
import { __test } from '../venice/agents/intent_employment.ts';

const {
  INTENT_EMPLOYMENT_MODEL,
  EMPLOYMENT_NOUL_THRESHOLD,
  EMPLOYMENT_MAX_INTENTS,
  EMPLOYMENT_STATE_BUDGET_CHARS,
  buildEmploymentRequest,
  parseEmploymentVerdicts,
  serializeTranscript,
  isDeterministicRejection,
} = __test;

const INTENTS = [
  { tag: 'e1', id: 'i1', statement: 'help them slow down' },
  { tag: 'e2', id: 'i2', statement: 'lean into reframing' },
];
const TAGS = new Set(INTENTS.map((i) => i.tag));

/** Build a /decisions-shaped payload for one tag's answers. */
function payloadFor(
  entries: Array<{
    tag: string;
    opening: number;
    acted: number;
    reaction?: string | null;
  }>,
): unknown {
  const answers: Record<string, unknown> = {};
  for (const e of entries) {
    answers[`opening-${e.tag}`] = { noul: e.opening };
    answers[`acted-${e.tag}`] = { noul: e.acted };
    if (e.reaction !== undefined) {
      answers[`reaction-${e.tag}`] = {
        choice: e.reaction === null ? 'none' : e.reaction,
        confidence: 0.9,
      };
    }
  }
  return { answers };
}

Deno.test('the judge rides the decision tier, not the chat palette', () => {
  assertEquals(INTENT_EMPLOYMENT_MODEL, 'clef-api');
});

Deno.test('budget constants', () => {
  assertEquals(EMPLOYMENT_NOUL_THRESHOLD, 0.5);
  assert(EMPLOYMENT_MAX_INTENTS >= 1);
  assertEquals(EMPLOYMENT_STATE_BUDGET_CHARS, 80_000);
});

Deno.test('body shape: model, fenced transcript state, three typed questions per intent', () => {
  const body = buildEmploymentRequest(INTENTS, '<transcript>...</transcript>');
  assertEquals(body.model, INTENT_EMPLOYMENT_MODEL);
  const state = body.state as {
    transcript: string;
    intents: Array<{ tag: string; statement: string }>;
  };
  assert(state.transcript.includes('<transcript>'));
  assertEquals(
    state.intents.map((i) => [i.tag, i.statement]),
    INTENTS.map((i) => [i.tag, i.statement]),
  );
  const questions = body.questions as Record<string, { type: string }>;
  for (const i of INTENTS) {
    assertEquals(questions[`opening-${i.tag}`].type, 'noul');
    assertEquals(questions[`acted-${i.tag}`].type, 'noul');
    assertEquals(questions[`reaction-${i.tag}`].type, 'choice');
  }
  assertEquals(Object.keys(questions).length, INTENTS.length * 3);
});

Deno.test('question instructions carry the firewall framing and the v1 rules', () => {
  const body = buildEmploymentRequest(INTENTS, 't');
  const q = body.questions as Record<
    string,
    { instructions: string; criteria: Record<string, string> }
  >;
  for (const id of Object.keys(q)) {
    assert(
      /NOT a judgment of whether the intention is good/i.test(q[id].instructions),
      `${id} must carry the firewall framing`,
    );
  }
  assert(/Do not invent openings/.test(q['opening-e1'].instructions));
  assert(/point to where the lean shows/.test(q['acted-e1'].instructions));
  assertEquals(Object.keys(q['reaction-e1'].criteria), [
    'receptive',
    'neutral',
    'resistant',
    'none',
  ]);
});

Deno.test('coercion reads a well-formed reply', () => {
  const m = parseEmploymentVerdicts(
    payloadFor([
      { tag: 'e1', opening: 0.9, acted: 0.8, reaction: 'receptive' },
      { tag: 'e2', opening: 0.2, acted: 0.0, reaction: 'none' },
    ]),
    TAGS,
  );
  assertEquals(m.get('e1'), { opening: true, acted: true, reaction: 'receptive' });
  assertEquals(m.get('e2'), { opening: false, acted: false, reaction: null });
});

Deno.test('acted cannot be true without an opening', () => {
  // A confident acted probability with no opening is corrected down,
  // and the reaction is nulled with it.
  const m = parseEmploymentVerdicts(
    payloadFor([{ tag: 'e1', opening: 0.2, acted: 0.9, reaction: 'receptive' }]),
    TAGS,
  );
  assertEquals(m.get('e1'), { opening: false, acted: false, reaction: null });
});

Deno.test('acted below the cut with an opening yields a no-action row', () => {
  const m = parseEmploymentVerdicts(
    payloadFor([{ tag: 'e1', opening: 0.9, acted: 0.3, reaction: 'receptive' }]),
    TAGS,
  );
  assertEquals(m.get('e1'), { opening: true, acted: false, reaction: null });
});

Deno.test('reaction only lands in the allowed set, and only when acted', () => {
  const base = { tag: 'e1', opening: 0.9, acted: 0.8 };
  // acted, pick 'none' -> null (did not act is impossible here, so
  // this reads as no observable signal).
  assertEquals(
    parseEmploymentVerdicts(payloadFor([{ ...base, reaction: 'none' }]), TAGS).get('e1')!
      .reaction,
    null,
  );
  // acted, pick outside the set -> null (row survives, reaction gone).
  assertEquals(
    parseEmploymentVerdicts(payloadFor([{ ...base, reaction: 'loudly' }]), TAGS).get('e1')!
      .reaction,
    null,
  );
  // not acted, pick present -> nulled by the acted gate.
  const m = parseEmploymentVerdicts(
    payloadFor([{ tag: 'e2', opening: 0.9, acted: 0.2, reaction: 'resistant' }]),
    TAGS,
  );
  assertEquals(m.get('e2')!.reaction, null);
  // acted, reaction answer missing entirely -> null, row still exists.
  const bare = parseEmploymentVerdicts(
    payloadFor([{ tag: 'e1', opening: 0.9, acted: 0.8 }]),
    TAGS,
  );
  assertEquals(bare.get('e1'), { opening: true, acted: true, reaction: null });
});

Deno.test('a tag with missing or malformed answers is dropped', () => {
  const missing = payloadFor([
    { tag: 'e1', opening: 0.9, acted: 0.8, reaction: 'receptive' },
    { tag: 'e2', opening: 0.9, acted: 0.8 },
  ]) as { answers: Record<string, unknown> };
  delete missing.answers['acted-e2'];
  const malformed = payloadFor([
    { tag: 'e1', opening: 0.9, acted: 0.8, reaction: 'receptive' },
    { tag: 'e2', opening: 0.9, acted: 0.8 },
  ]) as { answers: Record<string, unknown> };
  malformed.answers['opening-e2'] = { noul: 'high' };
  for (const payload of [missing, malformed]) {
    const m = parseEmploymentVerdicts(payload, TAGS);
    assertEquals(m.size, 1, 'only the well-answered tag survives');
    assert(m.has('e1'));
  }
});

Deno.test('malformed payloads coerce to an empty map', () => {
  for (const bad of [null, 42, 'x', {}, { answers: null }, { answers: 7 }]) {
    assertEquals(parseEmploymentVerdicts(bad, TAGS).size, 0, `payload ${JSON.stringify(bad)}`);
  }
});

Deno.test('tags outside validTags never enter the map', () => {
  const m = parseEmploymentVerdicts(
    payloadFor([{ tag: 'e9', opening: 0.9, acted: 0.9, reaction: 'receptive' }]),
    TAGS,
  );
  assertEquals(m.size, 0);
});

Deno.test('noul probabilities clamp to [0,1] before the cut', () => {
  const m = parseEmploymentVerdicts(
    payloadFor([
      { tag: 'e1', opening: 1.5, acted: -2, reaction: null },
      { tag: 'e2', opening: 0.5, acted: 0.5, reaction: null },
    ]),
    TAGS,
  );
  assertEquals(m.get('e1'), { opening: true, acted: false, reaction: null });
  // Exactly at the cut reads as yes (>=).
  assertEquals(m.get('e2'), { opening: true, acted: true, reaction: null });
});

function row(
  role: StoredMessage['role'],
  content: string,
  extra: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    id: 'x',
    role,
    content,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    ...extra,
  };
}

Deno.test('serializer renders role-tagged rows and clips oversize content', () => {
  const big = 'a'.repeat(30_000);
  const out = serializeTranscript([
    row('system', 'fork framing'),
    row('user', 'hello'),
    row('assistant', 'hi', {
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'shopping_list_add',
            arguments: '{"item":"'.concat('b'.repeat(400), '"}'),
          },
        },
      ],
    }),
    row('tool', big, { name: 'web_search' }),
  ]);
  assert(out.startsWith('<transcript>'));
  assert(out.endsWith('</transcript>'));
  assert(out.includes('[system]\nfork framing'));
  assert(out.includes('[user]\nhello'));
  assert(out.includes('[assistant]\nhi'));
  assert(out.includes('(tool calls)'));
  assert(out.includes('shopping_list_add('));
  assert(!out.includes('b'.repeat(400)));
  assert(out.includes('[tool result: web_search]'));
  assert(out.includes('...[clipped]'));
  assert(!out.includes(big));
});

Deno.test('the trimmed composite stays under the state budget', () => {
  const rows: StoredMessage[] = [];
  for (let i = 0; i < 40; i++) rows.push(row(i % 2 === 0 ? 'user' : 'assistant', `m${i}: ` + 'x'.repeat(5000)));
  const out = serializeTranscript(trimToCharBudget(rows, EMPLOYMENT_STATE_BUDGET_CHARS));
  assert(
    out.length < 90_000,
    `serialized ${out.length} chars must stay under the budget with slack`,
  );
});

Deno.test('failure classifier: deterministic 4xx advances the queue, the rest is transient', () => {
  assert(isDeterministicRejection(new VeniceError('x', 'http', 400)));
  assert(isDeterministicRejection(new VeniceError('x', 'http', 422)));
  assert(!isDeterministicRejection(new VeniceError('x', 'http', 500)));
  assert(!isDeterministicRejection(new VeniceError('x', 'rate_limit', 429)));
  assert(!isDeterministicRejection(new VeniceError('x', 'network')));
  assert(!isDeterministicRejection(new VeniceError('x', 'parse')));
  assert(!isDeterministicRejection(new Error('plain')));
  assert(!isDeterministicRejection(undefined));
});
