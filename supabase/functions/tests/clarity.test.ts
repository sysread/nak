// Offline coverage for the B8 clarity shared module (Deno island): the
// positive block's phrasing contract (positive-only - the priming-
// hazard rule), the mechanical scan's fault detection + code
// exemption, the rewrite ask's shape, and the tunables. The
// orchestrator-side wiring (the two-question call, the rewrite
// sequencing, the failure paths) is pinned in orchestrator.test.ts.
import { assert, assertEquals } from '@std/assert';
import {
  CLARITY_BLOCK,
  FAULT_CATALOG,
  RUBRIC_LEVELS,
  REWRITE_SCORE_THRESHOLD,
  CLARITY_NOTICE,
  describeFindings,
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

Deno.test('the fault catalog carries the detection classes the judge needs', () => {
  // The judge's criteria + the rewrite prompt's evidence reference
  // these by name; the catalog is the negative half of the standard.
  assert(FAULT_CATALOG.length >= 12);
  for (const f of FAULT_CATALOG) {
    assert(f.name.length > 0);
    assert(f.test.length > 0);
  }
});

Deno.test('the rubric has four ordered levels', () => {
  assertEquals(RUBRIC_LEVELS.length, 4);
});

Deno.test('the score threshold sits between multiple-violations and minor (0-indexed)', () => {
  // Live-verified wire: the score question is 0-indexed (0 = riddled,
  // 1 = multiple, 2 = minor, 3 = clean).
  assertEquals(REWRITE_SCORE_THRESHOLD, 1.5);
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

Deno.test('describeFindings renders the evidence lines for the rewrite ask', () => {
  const empty = describeFindings([], 3.2);
  assert(empty.includes('3.2'));
  assert(!empty.includes('flags') || !empty.includes('Flags'));
  const withFlags = describeFindings(
    [{ rule: 'dash', excerpt: '\u2014' }],
    1.2,
  );
  assert(withFlags.includes('dash'));
  assert(withFlags.includes('1.2'));
});

Deno.test('the notice copy is assistant-voiced and position-neutral', () => {
  assert(CLARITY_NOTICE.length > 0);
  assert(!/below/i.test(CLARITY_NOTICE), 'must not promise position (forks inherit the chip without the rewrite)');
});
