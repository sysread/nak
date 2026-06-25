// Pure backtest aggregator for the intents honest loop. Composes the
// kernels in intent-math.ts (matchedControlLift, pearson) into the
// CORPUS-LEVEL verdict that gates whether the feature could ever
// default on: do targeted patterns beat their matched controls, and is
// efficacy uncorrelated with employment (the firewall)? See
// docs/dev/in-progress/intents.md (Evaluation).
//
// This is offline analysis. The DB-reading harness that feeds it a real
// corpus (a query over intent_target_samples + intent_employments) is a
// later piece - it has nothing to read until weeks of opted-in usage
// accrue. For now `runBacktest` runs over best-guess fixtures
// (tests/intent-backtest.test.ts), shaped by what the prod descriptive
// layer already showed us, with a tripwire test that fails once real
// data should have replaced the guess.
//
// Self-contained but for the one relative import of the kernels.

import {
  matchedControlLift,
  pearson,
  type MovementWindow,
  type TargetDirection,
} from './intent-math.ts';

/** One efficacy time-series point for a targeted intent. */
export interface BacktestSample {
  target: number;
  control: number | null;
}

/** One intent's accrued backtest record (what the DB harness will build). */
export interface BacktestIntent {
  id: string;
  /** Free-form intents are excluded from lift + the firewall corr - they
   *  carry no target metric and no efficacy by design. */
  targeted: boolean;
  /** Ignored when !targeted. */
  direction: TargetDirection;
  /** Efficacy time-series, ordered oldest -> newest. */
  samples: readonly BacktestSample[];
  /** The efficacy posterior (null = unscored / free-form). */
  efficacy: number | null;
  /** How much the model employed the intent - the firewall's x-axis. */
  employmentCount: number;
}

// --- DB-row -> corpus assembly -----------------------------------------------
//
// The pure mapper from the shapes the prod query returns into the
// BacktestIntent[] the aggregator eats. This is the layer most likely to
// carry a bug when real data lands (sample ordering, per-intent grouping,
// the employment-count definition), so it is unit-tested with DB-shaped
// fixtures. The only piece NOT covered by tests is the literal SQL that
// produces these rows - a thin wrapper that needs real data to mean
// anything.

/** A row from `intents` (the metadata the corpus needs). */
export interface IntentMetaRow {
  id: string;
  target_kind: string;
  target_direction: string | null;
  efficacy: number | null;
}

/** A row from `intent_target_samples`. */
export interface TargetSampleRow {
  intent_id: string;
  target_value: number;
  control_value: number | null;
  /** ISO timestamp; the mapper sorts by this to order the series. */
  sampled_at: string;
}

/** A row from `intent_employments`. */
export interface EmploymentRow {
  intent_id: string;
  acted: boolean;
}

/**
 * Assemble the corpus from raw DB-shaped rows. Pure. Groups samples by
 * intent and orders each series oldest-first by `sampled_at`; counts
 * employment as the number of rows where the model ACTUALLY ACTED on the
 * intent (not mere openings) - that is the firewall's x-axis, "how much
 * did the model lean on this", which is what must NOT predict efficacy.
 * An intent with no samples yields an empty series (no windows), and
 * sample/employment rows pointing at an unknown intent are ignored.
 */
export function buildCorpus(args: {
  intents: readonly IntentMetaRow[];
  samples: readonly TargetSampleRow[];
  employments: readonly EmploymentRow[];
}): BacktestIntent[] {
  const samplesByIntent = new Map<string, TargetSampleRow[]>();
  for (const s of args.samples) {
    const list = samplesByIntent.get(s.intent_id);
    if (list) list.push(s);
    else samplesByIntent.set(s.intent_id, [s]);
  }

  const actedByIntent = new Map<string, number>();
  for (const e of args.employments) {
    if (!e.acted) continue; // only actual leans count toward employment
    actedByIntent.set(e.intent_id, (actedByIntent.get(e.intent_id) ?? 0) + 1);
  }

  return args.intents.map((meta) => {
    const rows = (samplesByIntent.get(meta.id) ?? [])
      .slice()
      .sort((a, b) => a.sampled_at.localeCompare(b.sampled_at));
    return {
      id: meta.id,
      targeted: meta.target_kind === 'bias' || meta.target_kind === 'samskara',
      direction: meta.target_direction === 'reinforce' ? 'reinforce' : 'reduce',
      samples: rows.map((r) => ({ target: r.target_value, control: r.control_value })),
      efficacy: meta.efficacy,
      employmentCount: actedByIntent.get(meta.id) ?? 0,
    };
  });
}

// --- The falsifiable bar -----------------------------------------------------
//
// PLACEHOLDERS. The entire point of the backtest is to set these from
// real data; they are eyeballed launch values, documented as such, and
// the tripwire test forces a revisit once prod data exists.
export const BAR_MIN_LIFT = 0.0; // targeted patterns must beat controls (lift > 0)
export const BAR_MAX_ABS_CORR = 0.3; // |corr(efficacy, employment)| must stay low
export const BAR_MIN_WINDOWS = 20; // enough movement windows to mean anything

export interface BacktestReport {
  nIntents: number;
  nTargeted: number;
  /** Control-bearing movement windows feeding the lift. */
  nWindows: number;
  /** Fraction of consecutive-sample pairs that carried a control value.
   *  Low coverage means the lift rests on few real counterfactuals - a
   *  health signal, surfaced rather than hidden. */
  controlCoverage: number;
  meanTarget: number;
  meanControl: number;
  /** meanTarget - meanControl; null when there are no windows. */
  lift: number | null;
  /** pearson(efficacy, employmentCount) over scored targeted intents. */
  efficacyEmploymentCorr: number;
  clearsBar: boolean;
  /** Human-readable reasons the bar was/wasn't cleared. */
  reasons: string[];
}

/**
 * Oriented, control-bearing movement windows for one targeted intent.
 * Orientation matches classifySample: for a `reduce` intent a downward
 * move is positive (improvement). Only consecutive pairs where BOTH
 * samples carry a control contribute - a window without a counterfactual
 * cannot feed a matched-control lift.
 */
export function intentWindows(intent: BacktestIntent): MovementWindow[] {
  if (!intent.targeted) return [];
  const sign = intent.direction === 'reduce' ? -1 : 1;
  const out: MovementWindow[] = [];
  for (let i = 1; i < intent.samples.length; i++) {
    const prev = intent.samples[i - 1];
    const curr = intent.samples[i];
    if (prev.control == null || curr.control == null) continue;
    out.push({
      targetMove: sign * (curr.target - prev.target),
      controlMove: sign * ((curr.control as number) - (prev.control as number)),
    });
  }
  return out;
}

/**
 * Run the corpus-level backtest. Builds control-bearing windows across
 * all targeted intents, computes the matched-control lift over them, and
 * the efficacy/employment correlation across scored targeted intents,
 * then applies the three-part bar. Pure.
 */
export function runBacktest(intents: readonly BacktestIntent[]): BacktestReport {
  const targeted = intents.filter((i) => i.targeted);

  let windows: MovementWindow[] = [];
  let totalPairs = 0;
  let controlPairs = 0;
  for (const it of targeted) {
    const w = intentWindows(it);
    windows = windows.concat(w);
    // Coverage denominator is ALL consecutive pairs, not just the
    // control-bearing ones intentWindows kept.
    totalPairs += Math.max(0, it.samples.length - 1);
    controlPairs += w.length;
  }

  const lr = matchedControlLift(windows);

  // Firewall: correlate efficacy against employment across scored
  // targeted intents. pearson returns 0 for < 2 points (the safe read).
  const scored = targeted.filter((i) => i.efficacy != null);
  const corr = pearson(
    scored.map((i) => i.efficacy as number),
    scored.map((i) => i.employmentCount),
  );

  const controlCoverage = totalPairs > 0 ? controlPairs / totalPairs : 0;

  const reasons: string[] = [];
  let clears = true;
  if (lr.lift == null || lr.lift <= BAR_MIN_LIFT) {
    clears = false;
    reasons.push('targeted patterns do not beat their controls (lift not positive)');
  }
  if (Math.abs(corr) > BAR_MAX_ABS_CORR) {
    clears = false;
    reasons.push('efficacy correlates with employment - firewall risk, the loop may be self-grading');
  }
  if (windows.length < BAR_MIN_WINDOWS) {
    clears = false;
    reasons.push(`insufficient data (${windows.length} windows < ${BAR_MIN_WINDOWS} required)`);
  }
  if (clears) reasons.push('clears the bar: positive lift, firewall intact, enough data');

  return {
    nIntents: intents.length,
    nTargeted: targeted.length,
    nWindows: windows.length,
    controlCoverage,
    meanTarget: lr.meanTarget,
    meanControl: lr.meanControl,
    lift: lr.lift,
    efficacyEmploymentCorr: corr,
    clearsBar: clears,
    reasons,
  };
}
