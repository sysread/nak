// Offline coverage for the B8/B9 clarity shared module (Deno island):
// the positive block's phrasing contract (positive-only - the
// priming-hazard rule), the mechanical scan's fault detection + code
// exemption, the composite builders (the failed-set derivation, the
// notice + connective + rewrite ask), the chip coercion (the ONE
// v1->v2 mapping owner), and the tunables. The orchestrator-side
// wiring (the three-question call body, the rewrite sequencing, the
// failure paths) is pinned in orchestrator.test.ts.
import { assert, assertEquals } from '@std/assert';
import {
  CLARITY_BLOCK,
  FAULT_CATALOG,
  RUBRIC_LEVELS,
  SMOOTHING_RUBRIC_LEVELS,
  SMOOTHING_REWRITE_THRESHOLD,
  REWRITE_SCORE_THRESHOLD,
  CLARITY_NOTICE,
  SMOOTHING_NOTICE,
  COMPOSITE_NOTICE,
  deriveFailedChecks,
  buildCompositeNotice,
  buildConnectiveThink,
  buildRewriteAsk,
  coerceClarityChip,
  type ClarityChipV2,
  mechanicalScan,
  stripCode,
} from '../_shared/clarity.ts';

Deno.test('the clarity block is positive-only: no anti-behavior phrasing', () => {
  // The priming-hazard rule: instructions never name the anti-
  // behavior, even to forbid it. The block must not carry negations
  // of the fault names or imperative "don't" phrasing.
  for (const banned of [
    'don\'t',
    "don't",
    'do not',
    'never',
    'avoid',
    'no sycophancy',
    'no em dash',
    'don\u2019t',
  ]) {
    assert(
      !CLARITY_BLOCK.toLowerCase().includes(banned.toLowerCase()),
      `the clarity block must not contain "${banned}" (positive phrasing only)`,
    );
  }
  // And it still teaches the standard's spine.
  for (const wanted of ['first sentence', 'One idea per sentence', 'say so plainly']) {
    assert(CLARITY_BLOCK.includes(wanted), `the block must carry: ${wanted}`);
  }
});

Deno.test('the block carries the B9 smoothing rule with its provenance', () => {
  // B9 D8: the reality-check contract, positive-phrased. The module
  // comment cites the derivation source; the rule itself names the
  // trigger (a wrong premise), the contract (a reality check), and
  // the joking exception.
  assert(CLARITY_BLOCK.includes('reality check'));
  assert(CLARITY_BLOCK.includes('the exception is a joke'));
});

Deno.test('the fault catalog carries the detection classes the judge needs', () => {
  // The judge's criteria + the rewrite prompt's evidence reference
  // these by name; the catalog is the negative half of the standard.
  assert(FAULT_CATALOG.length >= 12);
  for (const f of FAULT_CATALOG) {
    assert(f.name.length > 0);
    assert(f.test.length > 0);
  }
});

Deno.test('both rubrics have four ordered levels', () => {
  assertEquals(RUBRIC_LEVELS.length, 4);
  assertEquals(SMOOTHING_RUBRIC_LEVELS.length, 4);
});

Deno.test('both thresholds sit between multiple-violations and minor (0-indexed)', () => {
  // Live-verified wire: the score questions are 0-indexed (0 = worst
  // level, 3 = clean).
  assertEquals(REWRITE_SCORE_THRESHOLD, 1.5);
  assertEquals(SMOOTHING_REWRITE_THRESHOLD, 1.5);
});

Deno.test('mechanical scan: detects the mechanical tells', () => {
  const sloppy = mechanicalScan(
    'Great question! I think the answer is simply this \u2014 and it\u2019s worth noting the details\u2026',
  );
  const rules = sloppy.map((f) => f.rule);
  assert(rules.includes('sycophancy opener'), 'sycophancy opener detected');
  assert(rules.includes('hedge'), 'hedge detected');
  assert(rules.includes('dash'), 'dash detected');
  assert(rules.includes('smart quote'), 'smart quote detected');
  assert(rules.includes('ellipsis glyph'), 'ellipsis detected');
});

Deno.test('mechanical scan: clean prose passes, code is exempt', () => {
  assertEquals(mechanicalScan('The answer is 42. The reason follows: the math says so.'), []);
  assertEquals(
    mechanicalScan('Use this:\n```python\nx = f(a, b)  # note that -- the call\n```'),
    [],
  );
  // Inline code exempt too.
  assertEquals(mechanicalScan('Run `npm i --save-dev` first.'), []);
  assertEquals(stripCode('a `b -- c` d'), 'a   d');
});

Deno.test('deriveFailedChecks: the composite trigger table (B9 D4)', () => {
  // Fail-open per check: a null score means that check passed.
  assertEquals(deriveFailedChecks({ clarity: 0.8, smoothing: 2.9 }), ['clarity']);
  assertEquals(deriveFailedChecks({ clarity: 2.9, smoothing: 0.8 }), ['smoothing']);
  assertEquals(deriveFailedChecks({ clarity: 0.8, smoothing: 0.8 }), ['clarity', 'smoothing']);
  assertEquals(deriveFailedChecks({ clarity: 2.9, smoothing: 2.9 }), []);
  // The drift arms: a null degrades, never widens.
  assertEquals(deriveFailedChecks({ clarity: 0.8, smoothing: null }), ['clarity']);
  assertEquals(deriveFailedChecks({ clarity: null, smoothing: 0.8 }), ['smoothing']);
  assertEquals(deriveFailedChecks({ clarity: null, smoothing: null }), []);
});

Deno.test('buildCompositeNotice: the copy per failed set (B9 D6)', () => {
  assertEquals(buildCompositeNotice(['clarity']), CLARITY_NOTICE);
  assertEquals(buildCompositeNotice(['smoothing']), SMOOTHING_NOTICE);
  assertEquals(buildCompositeNotice(['smoothing', 'clarity']), COMPOSITE_NOTICE);
  // Canonical fallbacks: an unknown or empty set never yields ''.
  assertEquals(buildCompositeNotice([]), CLARITY_NOTICE);
  assertEquals(buildCompositeNotice(['bogus'] as unknown as ['clarity']), CLARITY_NOTICE);
});

Deno.test('the notice copies are assistant-voiced and position-neutral', () => {
  for (const notice of [CLARITY_NOTICE, SMOOTHING_NOTICE, COMPOSITE_NOTICE]) {
    assert(notice.length > 0);
    assert(!/below/i.test(notice), 'must not promise position (forks inherit the chip without the rewrite)');
  }
});

Deno.test('buildConnectiveThink: the copy per failed set (B9 D9)', () => {
  // Clarity-only: the original B8 line.
  assert(buildConnectiveThink(['clarity']).includes('reworded for clarity'));
  // Smoothing-only: never claims a clarity rewrite.
  const smoothingOnly = buildConnectiveThink(['smoothing']);
  assert(smoothingOnly.includes('smoothed things over'));
  assert(!smoothingOnly.includes('for clarity'));
  // Both: names both.
  const both = buildConnectiveThink(['clarity', 'smoothing']);
  assert(both.includes('for clarity'));
  assert(both.includes('smoothed things over'));
  // Fallback: unknown set degrades to the clarity line.
  assertEquals(buildConnectiveThink([]), buildConnectiveThink(['clarity']));
});

Deno.test('buildRewriteAsk: the ask assembles from the failed set (B9 D7)', () => {
  const original = 'The reply as it shipped.';
  const findings = [{ rule: 'dash', excerpt: '\u2014' }];
  // Clarity-only: clarity instruction + clarity evidence, no smoothing.
  const clarityOnly = buildRewriteAsk(
    ['clarity'],
    original,
    findings,
    { clarity: 1.2, smoothing: 2.9 },
  );
  assert(clarityOnly.includes('scored poorly for clarity'));
  assert(clarityOnly.includes('Clarity score: 1.2 of 4'));
  assert(clarityOnly.includes('dash'));
  assert(!clarityOnly.includes('Smoothing score'));
  assert(!clarityOnly.includes('smoothed things over'));
  // Smoothing-only: smoothing instruction + smoothing evidence, no
  // clarity line (the smoothing evidence never cites the clarity
  // score - per-check evidence).
  const smoothingOnly = buildRewriteAsk(
    ['smoothing'],
    original,
    [],
    { clarity: 2.9, smoothing: 0.8 },
  );
  assert(smoothingOnly.includes('smoothed things over'));
  assert(smoothingOnly.includes('reality check'));
  assert(smoothingOnly.includes('Smoothing score: 0.8 of 4'));
  assert(!smoothingOnly.includes('Clarity score'));
  // Both: both instructions, both evidence lines, one original.
  const both = buildRewriteAsk(
    ['clarity', 'smoothing'],
    original,
    findings,
    { clarity: 1.2, smoothing: 0.8 },
  );
  assert(both.includes('scored poorly for clarity'));
  assert(both.includes('smoothed things over'));
  assert(both.includes('Clarity score: 1.2 of 4'));
  assert(both.includes('Smoothing score: 0.8 of 4'));
  // The original rides fenced, whatever the set.
  for (const ask of [clarityOnly, smoothingOnly, both]) {
    assert(ask.includes('<original_reply>'));
    assert(ask.includes(original));
  }
  // Empty set: the drift posture degrades to the clarity ask.
  const fallback = buildRewriteAsk([], original, [], { clarity: null, smoothing: null });
  assert(fallback.includes('scored poorly for clarity'));
});

Deno.test('coerceClarityChip: v2 parses with the required-fields contract (B9 D5)', () => {
  const chip: ClarityChipV2 = {
    v: 2,
    checks: { clarity: 1.2, smoothing: 0.8 },
    failed: ['smoothing'],
    notice: 'notice text',
    rewrite_id: 'row-9',
  };
  assertEquals(coerceClarityChip(chip), chip);
  // Best-effort fields: a drifted checks/failed degrades to nulls/[]
  // while the notice still renders.
  assertEquals(
    coerceClarityChip({ v: 2, notice: 'n', rewrite_id: 'r' }),
    {
      v: 2,
      checks: { clarity: null, smoothing: null },
      failed: [],
      notice: 'n',
      rewrite_id: 'r',
    },
  );
  // Unknown check names drop out of failed; junk scores stay null.
  assertEquals(
    coerceClarityChip({ v: 2, checks: { clarity: 'junk' }, failed: ['bogus'], notice: 'n', rewrite_id: 'r' })
      ?.failed,
    [],
  );
});

Deno.test('coerceClarityChip: v1 maps forward, notice preserved (the prod chips)', () => {
  const v1 = { v: 1, score: 1.2769, notice: 'stored notice', rewrite_id: 'row-2' };
  assertEquals(coerceClarityChip(v1), {
    v: 2,
    checks: { clarity: 1.2769, smoothing: null },
    failed: ['clarity'],
    notice: 'stored notice',
    rewrite_id: 'row-2',
  });
  // A v1 row missing its score still renders the notice (best-effort).
  assertEquals(
    coerceClarityChip({ v: 1, notice: 'n', rewrite_id: 'r' })?.checks,
    { clarity: null, smoothing: null },
  );
});

Deno.test('coerceClarityChip: null for absent / junk / unknown versions', () => {
  assertEquals(coerceClarityChip(null), null);
  assertEquals(coerceClarityChip(undefined), null);
  assertEquals(coerceClarityChip('nope'), null);
  assertEquals(coerceClarityChip(42), null);
  assertEquals(coerceClarityChip({ v: 3, notice: 'n', rewrite_id: 'r' }), null);
  assertEquals(coerceClarityChip({ v: 2, rewrite_id: 'r' }), null);
  assertEquals(coerceClarityChip({ v: 2, notice: '  ' }), null);
});
