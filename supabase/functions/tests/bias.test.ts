// Offline coverage for the bias-sweep module's pure surface: the
// observer prompt must embed the full catalog (the prompt renders
// from _shared/bias-catalog.ts at module load - a broken render
// would ship an agent that can only fabricate bias names), and the
// tick's tunables are load-bearing for Venice spend. The DB- and
// Venice-coupled paths (claim, save, aggregate) are exercised by
// docs/qa/use-cases/bias-pipeline.md against a live stack.
import { assert, assertEquals } from 'jsr:@std/assert';
import { __test } from '../venice/agents/bias.ts';
import { BIAS_KEYS, BIAS_CATALOG } from '../_shared/bias-catalog.ts';

Deno.test('observer prompt embeds every catalog key with its guidance', () => {
  for (const key of BIAS_KEYS) {
    assert(
      __test.BIAS_OBSERVER_PROMPT.includes(`- ${key} - `),
      `prompt is missing catalog entry ${key}`,
    );
    assert(
      __test.BIAS_OBSERVER_PROMPT.includes(BIAS_CATALOG[key].guidance),
      `prompt is missing compensation guidance for ${key}`,
    );
  }
});

Deno.test('observer prompt keeps the structural sections', () => {
  // The falsification ladder and the output contract are the
  // behavior-parity core of the verbatim port - if a future edit
  // drops a section, the agent's false-positive posture changes
  // silently.
  for (const marker of [
    '# OBSERVATIONS',
    '# REACTIONS',
    '## Falsification - before reporting any bias, ask in order',
    '{"observations": [ ... ], "reactions": [ ... ]}',
    'Never report below 0.40 or above 0.85.',
  ]) {
    assert(
      __test.BIAS_OBSERVER_PROMPT.includes(marker),
      `prompt is missing section marker: ${marker}`,
    );
  }
});

Deno.test('sweep tunables hold their designed values', () => {
  // 10 analyze claims/tick bounds Venice spend; 24h is the aggregate
  // freshness floor. Changing either is a deliberate cost/latency
  // decision - see the constants' comments in agents/bias.ts.
  assertEquals(__test.ANALYZE_SWEEP_CAP, 10);
  assertEquals(__test.SUMMARY_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});
