// Unit coverage for the intent employment judge's pure parts (Deno
// island). The prompt assertions pin the JSON contract the parser
// reads and the firewall framing (process telemetry, NOT efficacy);
// the parser gets direct behavioral coverage.
import { assert, assertEquals } from 'jsr:@std/assert';
import { __test } from '../venice/agents/intent_employment.ts';

const { INTENT_EMPLOYMENT_PROMPT, buildEmploymentRequest, parseEmploymentVerdicts, stripJsonFence } =
  __test;

Deno.test('prompt declares the JSON contract the parser reads', () => {
  for (const key of ['"tag"', '"opening"', '"acted"', '"reaction"', '"reasoning"', '"employments"']) {
    assert(INTENT_EMPLOYMENT_PROMPT.includes(key), `prompt must name ${key}`);
  }
});

Deno.test('prompt frames this as telemetry, not an efficacy judgment (the firewall)', () => {
  assert(/NOT a judgment of whether the intention is good/i.test(INTENT_EMPLOYMENT_PROMPT));
});

Deno.test('buildEmploymentRequest tags each intention line', () => {
  const req = buildEmploymentRequest([
    { tag: 'e1', id: 'i1', statement: 'help them slow down' },
    { tag: 'e2', id: 'i2', statement: 'lean into reframing' },
  ]);
  assert(req.includes('e1: help them slow down'));
  assert(req.includes('e2: lean into reframing'));
});

const TAGS = new Set(['e1', 'e2']);

Deno.test('parseEmploymentVerdicts reads a well-formed reply', () => {
  const m = parseEmploymentVerdicts(
    JSON.stringify({
      employments: [
        { tag: 'e1', opening: true, acted: true, reaction: 'receptive', reasoning: 'asked for the method' },
        { tag: 'e2', opening: false, acted: false, reaction: null, reasoning: 'no occasion arose' },
      ],
    }),
    TAGS,
  );
  assertEquals(m.get('e1'), { opening: true, acted: true, reaction: 'receptive', reasoning: 'asked for the method' });
  assertEquals(m.get('e2'), { opening: false, acted: false, reaction: null, reasoning: 'no occasion arose' });
});

Deno.test('acted cannot be true without an opening', () => {
  // A sloppy reply claiming an action with no occasion is corrected.
  const m = parseEmploymentVerdicts(
    JSON.stringify({ employments: [{ tag: 'e1', opening: false, acted: true, reaction: 'receptive', reasoning: 'x' }] }),
    TAGS,
  );
  assertEquals(m.get('e1')!.acted, false);
  // reaction is nulled too, since there was no action to react to.
  assertEquals(m.get('e1')!.reaction, null);
});

Deno.test('reaction only survives when acted is true', () => {
  const m = parseEmploymentVerdicts(
    JSON.stringify({ employments: [{ tag: 'e1', opening: true, acted: false, reaction: 'resistant', reasoning: 'had a chance, did not take it' }] }),
    TAGS,
  );
  assertEquals(m.get('e1')!.acted, false);
  assertEquals(m.get('e1')!.reaction, null);
});

Deno.test('drops entries with unknown tags, missing reasoning, or bad shape', () => {
  const m = parseEmploymentVerdicts(
    JSON.stringify({
      employments: [
        { tag: 'e9', opening: true, acted: true, reaction: 'receptive', reasoning: 'unknown tag' },
        { tag: 'e1', opening: true, acted: true, reaction: 'receptive', reasoning: '   ' },
        'not an object',
      ],
    }),
    TAGS,
  );
  assertEquals(m.size, 0);
});

Deno.test('an invalid reaction string falls back to null, not a crash', () => {
  const m = parseEmploymentVerdicts(
    JSON.stringify({ employments: [{ tag: 'e1', opening: true, acted: true, reaction: 'thrilled', reasoning: 'x' }] }),
    TAGS,
  );
  assertEquals(m.get('e1')!.reaction, null);
});

Deno.test('returns empty on total garbage or a missing employments array', () => {
  assertEquals(parseEmploymentVerdicts('not json', TAGS).size, 0);
  assertEquals(parseEmploymentVerdicts('{"nope":[]}', TAGS).size, 0);
});

Deno.test('stripJsonFence removes a ```json fence', () => {
  assertEquals(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
});
