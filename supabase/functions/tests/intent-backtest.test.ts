// Coverage for the intents backtest aggregator (runBacktest) plus the
// PROVISIONAL fixtures that stand in for real prod data until weeks of
// opted-in usage accrue. A Deno test (not vitest): intent-backtest.ts
// lives in the Deno-island _shared tree and imports the kernels with a
// `.ts` extension, so it is type-checked here, not by the browser
// tsconfig.
//
// The fixtures are a best guess, shaped by the June 2026 prod
// inspection:
//   - intents are samskara-targeted, ~no bias targets (every bias was
//     floored/elided), reduce + reinforce mix;
//   - the samskara fire-frequency metric is topic-exogenous and swings
//     wildly window-over-window, so target and control move together and
//     the matched-control LIFT is expected ~0 (the honest expectation:
//     the feature does NOT clear the bar yet);
//   - two real weeks is far too little data (weekly sampling -> ~1 window
//     per intent), so a realistic 2-week corpus fails on volume alone.
//
// These are GUESSES. The TRIPWIRE test fails after a set date to force
// replacing them with the real shape from intent_target_samples +
// intent_employments. See docs/dev/in-progress/intents.md (Evaluation).
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert';
import {
  runBacktest,
  intentWindows,
  BAR_MIN_WINDOWS,
  type BacktestIntent,
  type BacktestSample,
} from '../_shared/intent-backtest.ts';

function series(targets: number[], controls: (number | null)[]): BacktestSample[] {
  return targets.map((t, i) => ({ target: t, control: controls[i] }));
}

// A targeted (reinforce) intent whose target rises by tStep and control
// by cStep over n windows. Builds corpora with a known lift.
function ramp(
  id: string,
  n: number,
  tStep: number,
  cStep: number,
  efficacy: number | null,
  employmentCount: number,
): BacktestIntent {
  const targets: number[] = [];
  const controls: number[] = [];
  for (let i = 0; i <= n; i++) {
    targets.push(i * tStep);
    controls.push(i * cStep);
  }
  return { id, targeted: true, direction: 'reinforce', samples: series(targets, controls), efficacy, employmentCount };
}

// === FIXTURES (provisional - refresh against prod; see the tripwire) ===

// (1) Realistic ~2-week corpus: 2 samskara-targeted intents (like the
// real account), weekly samples -> 1 window each, with the wild
// topic-driven swings the inspection found. Far too little data.
const TWO_WEEK_SPARSE: BacktestIntent[] = [
  {
    id: 'reduce-certainty',
    targeted: true,
    direction: 'reduce',
    // fire-freq fell 219 -> 25 while the cohort rose 264 -> 392: a huge
    // apparent "win" that is really topic drift, not intervention.
    samples: series([219, 25], [264, 392]),
    efficacy: 0.55,
    employmentCount: 4,
  },
  {
    id: 'reinforce-reframing',
    targeted: true,
    direction: 'reinforce',
    samples: series([180, 444], [200, 410]),
    efficacy: 0.6,
    employmentCount: 6,
  },
];

// (2) Enough data, NO real effect: target and control move together
// (topic-exogenous) so lift ~ 0. employmentCount held constant so
// efficacy spread provably cannot be explained by employment (corr := 0;
// the varying-employment leak case is LEAK). The honest expected outcome.
const ENOUGH_NO_EFFECT: BacktestIntent[] = Array.from({ length: 6 }, (_, k) =>
  ramp(`n${k}`, 4, 1, 1, [0.5, 0.62, 0.44, 0.58, 0.49, 0.53][k], 5),
);

// (3) Leak: efficacy tracks employment (= employment * 0.08), which the
// firewall must catch. Lift positive + data ample so the ONLY failing
// reason is the correlation.
const LEAK: BacktestIntent[] = [3, 8, 1, 9, 2, 7].map((emp, k) => ramp(`leak${k}`, 4, 1, 0.2, emp * 0.08, emp));

// (4) Clears the bar: target beats control every window (positive lift),
// firewall intact (constant employment), ample windows. Proves the bar
// is achievable, not trivially always-false.
const CLEARS: BacktestIntent[] = Array.from({ length: 6 }, (_, k) =>
  ramp(`c${k}`, 4, 1, 0.2, [0.7, 0.55, 0.66, 0.6, 0.72, 0.58][k], 5),
);

Deno.test('intentWindows orients reduce so a downward move is positive, and skips control-less pairs', () => {
  const intent: BacktestIntent = {
    id: 'x',
    targeted: true,
    direction: 'reduce',
    samples: series([10, 6, 6], [10, 9, null]),
    efficacy: null,
    employmentCount: 0,
  };
  // pair 0->1: targetMove = -(6-10)=+4 (dropped, good for reduce),
  // controlMove = -(9-10)=+1. pair 1->2 has a null control -> skipped.
  assertEquals(intentWindows(intent), [{ targetMove: 4, controlMove: 1 }]);
});

Deno.test('intentWindows returns nothing for a free-form intent', () => {
  assertEquals(
    intentWindows({ id: 'f', targeted: false, direction: 'reduce', samples: series([1, 2], [1, 2]), efficacy: null, employmentCount: 0 }),
    [],
  );
});

Deno.test('a realistic 2-week corpus does NOT clear the bar - too little data', () => {
  const r = runBacktest(TWO_WEEK_SPARSE);
  assertEquals(r.clearsBar, false);
  assert(r.nWindows < BAR_MIN_WINDOWS);
  assert(r.reasons.some((x) => /insufficient data/.test(x)));
});

Deno.test('enough data but no effect fails on lift, not the firewall', () => {
  const r = runBacktest(ENOUGH_NO_EFFECT);
  assert(r.nWindows >= BAR_MIN_WINDOWS);
  assertAlmostEquals(r.lift as number, 0, 1e-6); // target moved exactly as much as control
  assertEquals(r.clearsBar, false);
  assert(r.reasons.some((x) => /do not beat their controls/.test(x)));
  assert(!r.reasons.some((x) => /firewall/.test(x))); // efficacy was independent
});

Deno.test('catches a firewall leak: efficacy correlating with employment', () => {
  const r = runBacktest(LEAK);
  assert(Math.abs(r.efficacyEmploymentCorr) > 0.9);
  assertEquals(r.clearsBar, false);
  assert(r.reasons.some((x) => /firewall/.test(x)));
});

Deno.test('clears the bar when lift is positive, firewall intact, data ample', () => {
  const r = runBacktest(CLEARS);
  assert(r.nWindows >= BAR_MIN_WINDOWS);
  assert((r.lift as number) > 0);
  assert(Math.abs(r.efficacyEmploymentCorr) < 0.3);
  assertEquals(r.clearsBar, true);
});

Deno.test('reports control coverage and excludes free-form intents from windows', () => {
  const withFreeform: BacktestIntent[] = [
    ...CLEARS,
    { id: 'free', targeted: false, direction: 'reduce', samples: series([1, 2, 3], [null, null, null]), efficacy: null, employmentCount: 2 },
  ];
  const r = runBacktest(withFreeform);
  assertEquals(r.nTargeted, CLEARS.length); // free-form not counted
  assert(r.controlCoverage > 0 && r.controlCoverage <= 1);
});

// === TRIPWIRE ===============================================================
// The fixtures are a guess made before any real employment/efficacy data
// existed. This fails after the date below to force refreshing them - and
// the BAR_* thresholds - against the real shape in prod.
const FIXTURE_REFRESH_BY = Date.parse('2026-07-16T00:00:00Z');

Deno.test('TRIPWIRE: refresh fixtures + bar thresholds from prod data after the date', () => {
  if (Date.now() >= FIXTURE_REFRESH_BY) {
    throw new Error(
      'Intent backtest fixtures (supabase/functions/tests/intent-backtest.test.ts) are best-guess ' +
        'values authored 2026-06-25, before real intent_target_samples / intent_employments existed. ' +
        'It is now past the refresh date. Pull the real shape from prod, replace the fixtures, ' +
        're-derive the BAR_* thresholds in intent-backtest.ts from that data, and move this tripwire ' +
        'date forward (or delete it once the real DB harness drives the backtest). See ' +
        'docs/dev/in-progress/intents.md (Evaluation).',
    );
  }
});
