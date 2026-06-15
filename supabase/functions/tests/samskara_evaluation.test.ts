// Unit coverage for the samskara evaluation sweep's pure parts.
//
// The judge's verdict parser is the trust boundary between an LLM's
// JSON-object reply and the health/verdict writes - it must drop
// anything malformed rather than throw or coerce, so the sweep stays
// best-effort. The delta map's signs are the calibration contract slice
// 2 inherits. The prompt assertion pins the JSON shape the parser
// depends on, so a prompt edit that breaks the contract fails here.
import { assert, assertEquals } from 'jsr:@std/assert';
import { __test } from '../venice/agents/samskara_evaluation.ts';

const { parseVerdicts, buildVerdictRequest } = __test;

Deno.test('parseVerdicts keeps well-formed enum verdicts', () => {
  const m = parseVerdicts('{"p1":"held","p2":"contradicted","p3":"not-engaged"}');
  assertEquals(m.size, 3);
  assertEquals(m.get('p1'), 'held');
  assertEquals(m.get('p2'), 'contradicted');
  assertEquals(m.get('p3'), 'not-engaged');
});

Deno.test('parseVerdicts drops out-of-enum values but keeps valid siblings', () => {
  const m = parseVerdicts('{"p1":"held","p2":"maybe","p3":"YES","p4":"not-engaged"}');
  assertEquals(m.size, 2);
  assertEquals(m.get('p1'), 'held');
  assertEquals(m.get('p4'), 'not-engaged');
  assert(!m.has('p2'));
  assert(!m.has('p3'));
});

Deno.test('parseVerdicts returns empty on malformed JSON', () => {
  assertEquals(parseVerdicts('not json at all').size, 0);
  assertEquals(parseVerdicts('').size, 0);
});

Deno.test('parseVerdicts returns empty on non-object JSON', () => {
  // A JSON array or scalar is well-formed JSON but not a verdict map.
  assertEquals(parseVerdicts('["held","not-engaged"]').size, 0);
  assertEquals(parseVerdicts('"held"').size, 0);
  assertEquals(parseVerdicts('null').size, 0);
});

Deno.test('buildVerdictRequest names the three verdicts, the tags, and the JSON contract', () => {
  const req = buildVerdictRequest([
    { tag: 'p1', text: 'in situations like X the user tends to Y' },
    { tag: 'p2', text: 'when discussing Z the user gets terse' },
  ]);
  for (const v of ['"held"', '"contradicted"', '"not-engaged"']) {
    assert(req.includes(v), `missing verdict ${v}`);
  }
  assert(req.includes('p1:') && req.includes('p2:'), 'missing prediction tags');
  assert(req.includes('in situations like X'), 'missing prediction text');
  assert(req.includes('JSON object'), 'missing JSON-object instruction');
  // The skeptical default is load-bearing - pin that the prompt states it.
  assert(req.includes('DEFAULT to this when uncertain'), 'missing skeptical default');
});
