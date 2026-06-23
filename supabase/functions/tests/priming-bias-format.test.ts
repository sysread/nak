// Deno coverage for the bias-profile renderer (_shared/bias-format.ts).
// This block is the row-1 system appendix the priming stage appends to
// the wire; its exact bytes + the render-cap ordering are the contract
// (a drift changes what the model sees, silently). The catalog/math
// data it reads is parity-tested separately (tests/bias-catalog-parity).
import { assert, assertEquals } from 'jsr:@std/assert';
import { BIAS_CATALOG, BIAS_KEYS } from '../_shared/bias-catalog.ts';
import {
  type BiasSummaryRow,
  formatBiasProfileBlock,
  pickRenderable,
  RENDER_CAP,
} from '../_shared/bias-format.ts';

function row(over: Partial<BiasSummaryRow> & { bias: BiasSummaryRow['bias'] }): BiasSummaryRow {
  return {
    effectiveN: 10,
    posteriorAlpha: 5,
    posteriorBeta: 5,
    posteriorMean: 0.5,
    ciLower: 0.4,
    feedbackScore: 0,
    tier: 'soft',
    computedAt: new Date().toISOString(),
    ...over,
  };
}

Deno.test('no soft/strong rows -> null (cold start, all elided)', () => {
  assertEquals(formatBiasProfileBlock([]), null);
  assertEquals(formatBiasProfileBlock([row({ bias: BIAS_KEYS[0], tier: 'elided' })]), null);
});

Deno.test('pickRenderable: drops elided, sorts strong-before-soft then ciLower desc, caps at RENDER_CAP', () => {
  const rows: BiasSummaryRow[] = [
    row({ bias: BIAS_KEYS[0], tier: 'soft', ciLower: 0.20 }),
    row({ bias: BIAS_KEYS[1], tier: 'strong', ciLower: 0.35 }),
    row({ bias: BIAS_KEYS[2], tier: 'elided', ciLower: 0.99 }),
    row({ bias: BIAS_KEYS[3], tier: 'strong', ciLower: 0.50 }),
  ];
  const picks = pickRenderable(rows);
  assertEquals(picks.map((r) => r.bias), [BIAS_KEYS[3], BIAS_KEYS[1], BIAS_KEYS[0]]);
  assert(picks.length <= RENDER_CAP);
});

Deno.test('RENDER_CAP bounds the rendered set even when more clear tier', () => {
  const rows = BIAS_KEYS.slice(0, RENDER_CAP + 3).map((bias, i) =>
    row({ bias, tier: 'strong', ciLower: 0.9 - i * 0.01 }),
  );
  assertEquals(pickRenderable(rows).length, RENDER_CAP);
});

Deno.test('block: header, framing rules, whimsy exception, and per-bias guidance', () => {
  const strongKey = BIAS_KEYS[0];
  const softKey = BIAS_KEYS[1];
  const block = formatBiasProfileBlock([
    row({ bias: strongKey, tier: 'strong', ciLower: 0.4 }),
    row({ bias: softKey, tier: 'soft', ciLower: 0.2 }),
  ]);
  assert(block !== null);
  const b = block!;
  assert(b.includes('# User profile - observed cognitive patterns'));
  // Tier word + lowercased label + the catalog guidance for each pick.
  assert(b.includes(`Consistently ${BIAS_CATALOG[strongKey].label.toLowerCase()}: ${BIAS_CATALOG[strongKey].guidance}`));
  assert(b.includes(`Occasionally ${BIAS_CATALOG[softKey].label.toLowerCase()}: ${BIAS_CATALOG[softKey].guidance}`));
  assert(b.includes('General framing rules that apply across all observed patterns:'));
  // The whimsy exception is load-bearing against pedantic over-correction.
  assert(b.toLowerCase().includes('jokes'));
});
