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

const { parseVerdicts, buildVerdictRequest, chunkPredictions } = __test;

Deno.test('parseVerdicts keeps well-formed enum verdicts', () => {
  const m = parseVerdicts(
    '{"p1":"held","p2":"contradicted","p3":"not-borne-out","p4":"not-engaged"}',
  );
  assertEquals(m.size, 4);
  assertEquals(m.get('p1'), 'held');
  assertEquals(m.get('p2'), 'contradicted');
  assertEquals(m.get('p3'), 'not-borne-out');
  assertEquals(m.get('p4'), 'not-engaged');
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

Deno.test('buildVerdictRequest names the four verdicts, the tags, and the JSON contract', () => {
  const req = buildVerdictRequest([
    { tag: 'p1', text: 'in situations like X the user tends to Y' },
    { tag: 'p2', text: 'when discussing Z the user gets terse' },
  ]);
  for (const v of ['"held"', '"contradicted"', '"not-borne-out"', '"not-engaged"']) {
    assert(req.includes(v), `missing verdict ${v}`);
  }
  assert(req.includes('p1:') && req.includes('p2:'), 'missing prediction tags');
  assert(req.includes('in situations like X'), 'missing prediction text');
  assert(req.includes('JSON object'), 'missing JSON-object instruction');
  // The situation-first decision tree is the whole point of the split;
  // pin that the prompt asks the situation question before the outcome.
  assert(req.includes('did the SITUATION'), 'missing situation-first gate');
});

Deno.test('buildVerdictRequest scopes the skeptical default to the engagement step', () => {
  // The two-step shape is load-bearing: an earlier single-step framing
  // let "default to not-engaged" swallow not-borne-out entirely (zero
  // soft-miss verdicts across 19k judged fires in prod), which pinned
  // every health posterior at the population prior. Pin the three
  // pieces that prevent a regression to that shape: the explicit
  // steps, the default on the engagement question, and the rule that
  // an engaged prediction may not fall back to not-engaged.
  const req = buildVerdictRequest([{ tag: 'p1', text: 'x' }]);
  assert(req.includes('STEP 1') && req.includes('STEP 2'), 'missing two-step structure');
  assert(req.includes('DEFAULT to'), 'missing skeptical engagement default');
  assert(
    req.includes('do NOT fall back to "not-engaged"'),
    'missing the no-fallback rule that keeps not-borne-out reachable',
  );
  assert(req.includes('Worked examples'), 'missing worked examples');
});

Deno.test('buildVerdictRequest holds "held" to pointable evidence, not consistency', () => {
  // The rubber-stamp failure mode: broad meta-tendency predictions are
  // consistent with any ordinary engaged conversation, and a judge that
  // treats consistency as confirmation ruled 92.5% of genuine tests
  // 'held' in prod - pinning the population prior at ~0.95 and leaving
  // the posterior nothing to discriminate with. Pin the three pieces of
  // the bar: the pointable-moment requirement, the counterfactual test,
  // and the broad-prediction worked example that routes the
  // consistent-but-undemonstrated case to not-borne-out.
  const req = buildVerdictRequest([{ tag: 'p1', text: 'x' }]);
  assert(req.includes('SPECIFIC moment'), 'missing the pointable-moment requirement');
  assert(
    req.includes('look any different if the prediction were false'),
    'missing the counterfactual test',
  );
  assert(
    req.includes('Mere consistency is NOT confirmation'),
    'missing the consistency-is-not-confirmation rule',
  );
  assert(
    req.includes('broad prediction'),
    'missing the broad-prediction worked example',
  );
});

Deno.test('chunkPredictions splits into ordered batches with a short tail', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  assertEquals(chunkPredictions(items, 2), [['a', 'b'], ['c', 'd'], ['e']]);
  // Exact multiple: no empty trailing batch.
  assertEquals(chunkPredictions(items.slice(0, 4), 2), [['a', 'b'], ['c', 'd']]);
  // A list inside one batch stays a single completion.
  assertEquals(chunkPredictions(items, 20), [items]);
  assertEquals(chunkPredictions([], 20), []);
});
