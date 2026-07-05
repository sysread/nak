// Deno coverage for the samskara priming formatter
// (venice/priming/samskara-format.ts). Pure projection of the compound
// summary + situational fire into two <think> bodies; the wire bytes
// and the budget-trim behavior are the contract. Restores the coverage
// the retired browser tests/samskara-format.test.ts held, on the side
// that now runs it.
import { assert, assertEquals } from 'jsr:@std/assert';
import {
  formatPrimingThinks,
  formatRefinementFireThink,
  type FireResult,
  type FiredSamskara,
  topKForCorpusSize,
} from '../venice/priming/samskara-format.ts';

function fired(over: Partial<FiredSamskara> = {}): FiredSamskara {
  return {
    id: crypto.randomUUID(),
    prediction: 'the user prefers terse answers',
    innerVoice: null,
    valence: 0,
    confidence: 0.7,
    health: 0.9,
    score: 0.8,
    ...over,
  };
}
function result(fires: FiredSamskara[]): FireResult {
  return { cohortId: crypto.randomUUID(), fired: fires };
}

Deno.test('compound: null when summary empty/whitespace, trimmed when present', () => {
  assertEquals(formatPrimingThinks({ compoundSummary: null, fire: null }).compound, null);
  assertEquals(formatPrimingThinks({ compoundSummary: '   ', fire: null }).compound, null);
  assertEquals(
    formatPrimingThinks({ compoundSummary: '  the user is a pirate  ', fire: null }).compound,
    'the user is a pirate',
  );
});

Deno.test('fire: null when no fired rows', () => {
  assertEquals(formatPrimingThinks({ compoundSummary: null, fire: null }).fire, null);
  assertEquals(formatPrimingThinks({ compoundSummary: null, fire: result([]) }).fire, null);
});

Deno.test('fire: renders the orientation sentence + one bullet per fire', () => {
  const out = formatPrimingThinks({
    compoundSummary: null,
    fire: result([fired({ prediction: 'wants citations' })]),
  });
  assert(out.fire !== null);
  assert(out.fire!.includes('Some things I\'ve come to expect about this user'));
  assert(out.fire!.includes('- wants citations'));
});

Deno.test('fire: hedge bands key off the score', () => {
  const hedge = (score: number) =>
    formatPrimingThinks({ compoundSummary: null, fire: result([fired({ score })]) }).fire!;
  assert(hedge(1.2).includes("I'm pretty sure"));
  assert(hedge(0.8).includes('fairly confident'));
  assert(hedge(0.5).includes('I think'));
  assert(hedge(0.2).includes('just a hunch'));
});

Deno.test('fire: a body over budget is trimmed (abbreviate then drop tail)', () => {
  // Many long-prediction fires blow PRIMING_CHAR_BUDGET; the formatter
  // abbreviates past the top three then drops the lowest-scoring tail
  // until it fits, so the rendered body never runs away.
  const many = Array.from({ length: 40 }, (_, i) =>
    fired({
      prediction: `prediction number ${i} `.repeat(12),
      innerVoice: 'an inner voice fragment that is fairly long and should be dropped under budget pressure',
      score: 1 - i * 0.01,
    }),
  );
  const out = formatPrimingThinks({ compoundSummary: null, fire: result(many) }).fire!;
  // PRIMING_CHAR_BUDGET (2400) bounds the BULLET body; formatPrimingThinks
  // prepends a fixed orientation sentence (~80 chars) on top, so the final
  // string lands just over budget, not at the unbounded ~40-bullet size.
  assert(out.length <= 2400 + 120, `fire body ${out.length} not trimmed to budget`);
  // The drop-tail ran: not all 40 fires survived.
  const bulletCount = out.split('\n').filter((l) => l.startsWith('- ')).length;
  assert(bulletCount < 40, `expected trimming, got ${bulletCount} bullets`);
});

Deno.test('topKForCorpusSize: max(1, ceil(kBase * log10(n + 10)))', () => {
  assertEquals(topKForCorpusSize(0, 5), Math.max(1, Math.ceil(5 * Math.log10(10))));
  assertEquals(topKForCorpusSize(90, 5), Math.max(1, Math.ceil(5 * Math.log10(100))));
  // Floor at 1 so an empty corpus never asks for 0 rows.
  assert(topKForCorpusSize(0, 0) >= 1);
});

Deno.test('refinement think: null on empty, adjudication framing + bullets when fired', () => {
  assertEquals(formatRefinementFireThink(null), null);
  assertEquals(formatRefinementFireThink([]), null);
  const out = formatRefinementFireThink([fired({ prediction: 'wants citations' })]);
  assert(out !== null);
  // The orientation frames the bullets as evidence for weighing the
  // doubt, not as fresh conversational priming.
  assert(out!.includes('whether it holds'));
  assert(out!.includes('- wants citations'));
  // Shares the standard block's hedge rendering.
  assert(out!.includes('fairly confident'));
});
