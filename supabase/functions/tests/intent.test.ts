// Unit coverage for the intent minting agent's pure parts (Deno
// island). The prompt assertions pin the structural contract the
// parser and the renderer depend on - a prompt edit that dropped the
// JSON-envelope keys, the dispositional-lean rule, or the
// user-precedence constraint would break the feature's behavior
// silently, so it fails here instead. The parser/builder get direct
// behavioral coverage.
import { assert, assertEquals } from 'jsr:@std/assert';
import { __test, type MinterInput } from '../venice/agents/intent.ts';

const {
  INTENT_MINTER_PROMPT,
  buildMinterPayload,
  parseMinterResponse,
  stripJsonFence,
} = __test;

// --- Prompt contract -------------------------------------------------------

Deno.test('prompt declares the four-verb JSON envelope the parser reads', () => {
  for (const key of ['"create"', '"retire"', '"dormant"', '"revive"']) {
    assert(INTENT_MINTER_PROMPT.includes(key), `prompt must name ${key}`);
  }
  // The target sub-shape the processor coerces.
  assert(INTENT_MINTER_PROMPT.includes('"kind"'));
  assert(INTENT_MINTER_PROMPT.includes('"direction"'));
});

Deno.test('prompt requires dispositional leans, not commands', () => {
  // The renderer keeps statements verbatim and frames them as leans;
  // an imperative statement would reintroduce the bias/intent conflict.
  assert(/dispositional lean/i.test(INTENT_MINTER_PROMPT));
  assert(/never a command/i.test(INTENT_MINTER_PROMPT));
});

Deno.test('prompt makes pruning first-class (the ability to abandon)', () => {
  // "Changing its mind" is the point; the prompt must instruct retire
  // and pause, not only create.
  assert(/RETIRE/.test(INTENT_MINTER_PROMPT));
  assert(/DORMANT/.test(INTENT_MINTER_PROMPT));
  assert(/REVIVE/.test(INTENT_MINTER_PROMPT));
  assert(/lever is wrong/i.test(INTENT_MINTER_PROMPT));
});

Deno.test('prompt puts the user\'s explicit instructions above any intention', () => {
  assert(/user_system_prompts/.test(INTENT_MINTER_PROMPT));
  assert(/stated wishes always win/i.test(INTENT_MINTER_PROMPT));
});

Deno.test('prompt keeps the never-clinical hygiene without a topic gate', () => {
  // No topic restriction was the product decision; the hygiene stays.
  assert(/never clinical, never diagnostic/i.test(INTENT_MINTER_PROMPT));
});

// --- Payload builder -------------------------------------------------------

const sampleInput: MinterInput = {
  existingIntents: [
    {
      id: 'i1',
      statement: 'help them test beliefs before committing',
      status: 'active',
      target: { kind: 'bias', ref: 'confirmation_bias', direction: 'reduce' },
      efficacy: 0.42,
      openings: 5,
      acted: 4,
      reactions: ['receptive', 'neutral'],
    },
  ],
  samskaraSummary: 'Tends to seek quick certainty under time pressure.',
  topSamskaras: [{ id: 's1', prediction: 'asks for the answer, not the method', valence: -0.2, health: 0.7 }],
  biases: [{ key: 'confirmation_bias', label: 'Confirmation bias', tier: 'strong' }],
  userSystemPrompts: ['Be concise.'],
  memories: ['Prefers worked examples.'],
  wiki: [],
  recentThreads: ['Debugging a deploy; wanted the fix fast.'],
};

Deno.test('buildMinterPayload emits valid JSON with the prompt\'s key names', () => {
  const payload = buildMinterPayload(sampleInput);
  const obj = JSON.parse(payload);
  assertEquals(obj.existing_intents[0].id, 'i1');
  assertEquals(obj.existing_intents[0].efficacy, 0.42);
  assertEquals(obj.top_samskaras[0].id, 's1');
  assertEquals(obj.biases[0].key, 'confirmation_bias');
  assertEquals(obj.user_system_prompts[0], 'Be concise.');
  // Keys must match what the prompt tells the model to expect.
  assert('samskara_summary' in obj);
  assert('recent_threads' in obj);
});

// --- Response parsing ------------------------------------------------------

Deno.test('stripJsonFence removes a ```json fence', () => {
  assertEquals(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  assertEquals(stripJsonFence('{"a":1}'), '{"a":1}');
});

Deno.test('parseMinterResponse extracts all four arrays', () => {
  const out = parseMinterResponse(
    JSON.stringify({
      create: [{ statement: 'x' }],
      retire: ['a'],
      dormant: ['b'],
      revive: ['c'],
    }),
  )!;
  assertEquals(out.rawCreates.length, 1);
  assertEquals(out.rawRetires, ['a']);
  assertEquals(out.rawDormant, ['b']);
  assertEquals(out.rawRevive, ['c']);
});

Deno.test('parseMinterResponse tolerates missing keys', () => {
  const out = parseMinterResponse('{"retire":["a"]}')!;
  assertEquals(out.rawRetires, ['a']);
  assertEquals(out.rawCreates, []);
  assertEquals(out.rawDormant, []);
  assertEquals(out.rawRevive, []);
});

Deno.test('parseMinterResponse returns null on total garbage', () => {
  assertEquals(parseMinterResponse('not json at all'), null);
  assertEquals(parseMinterResponse('42'), null); // not an object
});

Deno.test('parseMinterResponse coerces a non-array key to an empty array', () => {
  const out = parseMinterResponse('{"create":"oops","retire":["a"]}')!;
  assertEquals(out.rawCreates, []);
  assertEquals(out.rawRetires, ['a']);
});
