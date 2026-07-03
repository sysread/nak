/**
 * UI-behavior primitives for the bias-profile diagnostics modal.
 * Pure functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/screens/BiasProfile.svelte` composes these with
 * its own framework-native reactivity (state runes, supabase
 * fetch orchestration, navigation patches, and the markup).
 */

import { BIAS_CATALOG } from '$lib/bias/catalog';
import { type BiasKey, isBiasKey } from '$lib/bias/catalog-keys';
import {
  ALPHA_PRIOR,
  BETA_PRIOR,
  CI_LB_SOFT,
  CI_LB_STRONG,
  FEEDBACK_THRESHOLD_DELTA,
  N_EFF_FLOOR,
  RENDER_CAP,
  type Tier,
} from '$lib/bias/types';

/**
 * The slice of a `bias_summary` row the modal renders. Narrower
 * than `BiasSummaryRow` in `$lib/bias/types` on purpose: `bias`
 * stays free text here (the DB has no enum check, so a row can
 * carry a key the catalog no longer knows and the modal display-
 * tolerates it rather than dropping it), and the modal never
 * touches the raw posterior alpha/beta.
 */
export interface BiasSummaryDisplayRow {
  bias: string;
  effectiveN: number;
  posteriorMean: number;
  ciLower: number;
  feedbackScore: number;
  tier: Tier;
}

/**
 * Sort summary rows for the table: strong tier first, then soft,
 * then elided; within each tier, by ciLower descending so the
 * strongest signal lands at the top. Returns a fresh array; the
 * input is not mutated.
 */
export function sortSummaryRows(
  rows: readonly BiasSummaryDisplayRow[],
): BiasSummaryDisplayRow[] {
  const tierWeight = (t: string): number =>
    t === 'strong' ? 0 : t === 'soft' ? 1 : 2;
  return [...rows].sort((a, b) => {
    const t = tierWeight(a.tier) - tierWeight(b.tier);
    if (t !== 0) return t;
    return b.ciLower - a.ciLower;
  });
}

/**
 * The rows whose compensation guidance rides into the system
 * prompt this turn (post render-cap): soft+strong only, top
 * RENDER_CAP by ciLower. The modal's "in prompt" pill reads a key
 * set derived from this so the user can see which biases are
 * actually shaping responses right now, not just which ones
 * cleared the tier gate. Mirrors the server-side selection in
 * supabase/functions/_shared/bias-format.ts.
 */
export function renderedBiasRows(
  rows: readonly BiasSummaryDisplayRow[],
): BiasSummaryDisplayRow[] {
  return rows
    .filter((r) => r.tier === 'soft' || r.tier === 'strong')
    .sort((a, b) => b.ciLower - a.ciLower)
    .slice(0, RENDER_CAP);
}

/**
 * Display label for a catalog key. The DB stores `bias` as free
 * text (no enum check), so a persisted row can name a key the
 * catalog no longer carries; falling back to the raw key keeps
 * the row legible instead of blanking it.
 */
export function biasLabel(key: string): string {
  if (!isBiasKey(key)) return key;
  return BIAS_CATALOG[key as BiasKey].label;
}

/**
 * Catalog definition for a bias key; empty string for unknown
 * keys (the surrounding card still renders the label, so a blank
 * definition line degrades quietly).
 */
export function biasDefinition(key: string): string {
  if (!isBiasKey(key)) return '';
  return BIAS_CATALOG[key as BiasKey].definition;
}

/**
 * The pre-written compensation guidance string for a bias - the
 * same text that rides into the chat LLM's system prompt when
 * the bias clears a tier. Surfaced in the "Current conversation"
 * section so the user can see what the assistant is being told
 * about them, not just the bias name. Empty string for unknown
 * keys.
 */
export function biasGuidance(key: string): string {
  if (!isBiasKey(key)) return '';
  return BIAS_CATALOG[key as BiasKey].guidance;
}

/** Locale-formatted wall-clock timestamp; empty string for null
 *  so optional dates render as nothing rather than "null". */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Probability as a tenths-precision percentage ("12.3%") - the
 *  CI-lower and posterior-mean columns. */
export function formatProbability(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

/** Effective sample size to one decimal - it is a sum of recency
 *  weights, not an integer count. */
export function formatEffectiveN(n: number): string {
  return n.toFixed(1);
}

/**
 * Feedback score is signed in [-1, +1]. Render with an explicit
 * sign so the polarity reads at a glance; +0.00 / -0.00 also
 * collapse to the neutral 0.00.
 */
export function formatFeedback(n: number): string {
  const abs = Math.abs(n);
  if (abs < 0.005) return '0.00';
  const sign = n > 0 ? '+' : '-';
  return `${sign}${abs.toFixed(2)}`;
}

/**
 * Whole-percent confidence label for an observation card. Raw
 * confidences are clamped to [0.40, 0.85] at ingest, so tenths
 * would imply precision the pipeline does not have - unlike the
 * CI columns, which get formatProbability's tenths.
 */
export function formatConfidence(n: number): string {
  return (n * 100).toFixed(0) + '%';
}

/**
 * Render-time tag for a reaction's three-state was_confirmed.
 */
export function reactionVerdict(wasConfirmed: boolean | null): string {
  if (wasConfirmed === true) return 'affirmed';
  if (wasConfirmed === false) return 'pushed back';
  return 'neutral';
}

/**
 * Reaction verdict to the CSS colorway key, parallel to
 * `reactionVerdict` the same way the tier badge pairs its label
 * with a class. Matches the `.reaction-verdict.*` rules in the
 * modal's stylesheet: affirmed (accent-tinted), pushed
 * (danger-tinted), neutral (subtle gray).
 */
export function reactionVerdictClass(
  wasConfirmed: boolean | null,
): 'affirmed' | 'pushed' | 'neutral' {
  if (wasConfirmed === true) return 'affirmed';
  if (wasConfirmed === false) return 'pushed';
  return 'neutral';
}

/**
 * Has the sweep ever flagged this bias for the user? Distinct
 * from "is the row above the N_eff floor": effective_n counts
 * processed conversations (with pConv=0 for no-hits), while this
 * counts raw observation rows. Zero observations means the
 * row's ci_lower is just the prior's 10th-percentile (~5%)
 * dragged slightly down by the cumulative no-hit denominator -
 * not actual signal. Drives the "no evidence" rendering.
 * `counts` is the modal's per-bias observation-count map, passed
 * in so the primitive stays pure of component state.
 */
export function hasEvidence(
  counts: Record<string, number>,
  biasKey: string,
): boolean {
  return (counts[biasKey] ?? 0) > 0;
}

/**
 * Subjective, prose-y interpretation of a row's numbers. The
 * stats grid carries the raw values; this paragraph translates
 * them into "what does this actually mean for me?" for readers
 * who do not want to translate a 90% credible interval lower
 * bound on a Beta-Binomial posterior into intuition on the fly.
 *
 * Branches: no-observations (never flagged, ci_lower is just the
 * prior's 10th-percentile), below-N-floor (numbers are mostly
 * prior), elided-but-above-floor (weak signal, no surfacing),
 * soft tier (occasional pattern), strong tier (consistent
 * pattern). The soft/strong arms also note when a bias is
 * at-tier but bumped out by RENDER_CAP. A trailing feedback
 * sentence appears only when the EMA is meaningful (|score| >=
 * 0.10) - below that the gate shift rounds to zero anyway.
 *
 * `hasAnyEvidence` is the `hasEvidence` read for this row's key,
 * passed in because the counts map lives in component state.
 */
export function interpretBias(
  row: BiasSummaryDisplayRow,
  isRendered: boolean,
  hasAnyEvidence: boolean,
): string {
  const pct = (n: number): string => (n * 100).toFixed(1) + '%';
  const noObservations = !hasAnyEvidence;
  const belowFloor = row.effectiveN < N_EFF_FLOOR;

  let core: string;
  if (noObservations) {
    // The ci_lower sits at the prior's 10th-percentile (~5%) plus
    // a small downward drift from cumulative no-hit denominator
    // mass; the percentage itself is uninformative, so the prose
    // leans on "never flagged" rather than the number.
    core =
      `No evidence - the analysis has never flagged this bias in any ` +
      `analyzed conversation. The stats above are just the ` +
      `Beta(${ALPHA_PRIOR}, ${BETA_PRIOR}) prior with the ` +
      `cumulative no-hit denominator from processed conversations ` +
      `pulling the posterior slightly below the prior mean ` +
      `of ~20%.`;
  } else if (belowFloor) {
    const shortfall = Math.max(0, N_EFF_FLOOR - row.effectiveN).toFixed(1);
    core =
      `Mostly prior - only ${formatEffectiveN(row.effectiveN)} ` +
      `effective observations (recency-weighted) against the ` +
      `floor of ${N_EFF_FLOOR}. The posterior mean of ` +
      `${pct(row.posteriorMean)} is dominated by the default ` +
      `Beta(${ALPHA_PRIOR}, ${BETA_PRIOR}) prior (mean ~20%); ` +
      `about ${shortfall} more recency-weighted observations ` +
      `needed before any signal can clear the floor.`;
  } else if (row.tier === 'elided') {
    core =
      `Weak signal - 90% confident the underlying rate is at ` +
      `least ${pct(row.ciLower)}, below the ${pct(CI_LB_SOFT)} ` +
      `soft gate. Not surfacing in the system prompt.`;
  } else if (row.tier === 'soft') {
    const trailing = isRendered
      ? ` Surfaces as a light "occasionally" nudge in the system prompt.`
      : ` Outside the top ${RENDER_CAP} by CI lower this turn, ` +
        `so the system prompt skips it.`;
    core =
      `Occasional pattern - 90% lower bound of ` +
      `${pct(row.ciLower)} clears the soft gate ` +
      `(${pct(CI_LB_SOFT)}) but not strong ` +
      `(${pct(CI_LB_STRONG)}).` +
      trailing;
  } else {
    const trailing = isRendered
      ? ` Surfaces as a firm "consistently" nudge in the system prompt.`
      : ` Outside the top ${RENDER_CAP} by CI lower this turn, ` +
        `so the system prompt skips it.`;
    core =
      `Consistent pattern - 90% lower bound of ` +
      `${pct(row.ciLower)} clears the strong gate ` +
      `(${pct(CI_LB_STRONG)}).` +
      trailing;
  }

  const fb = row.feedbackScore;
  if (Math.abs(fb) >= 0.1) {
    const delta = (Math.abs(fb) * FEEDBACK_THRESHOLD_DELTA).toFixed(2);
    if (fb > 0) {
      core +=
        ` Feedback ${formatFeedback(fb)} shifts both gates down ` +
        `by ${delta}, surfacing this sooner.`;
    } else {
      core +=
        ` Feedback ${formatFeedback(fb)} shifts both gates up ` +
        `by ${delta}, raising the bar to surface.`;
    }
  }

  return core;
}

/**
 * Hue for the landscape bar - encodes where this bias's CI
 * lower sits relative to the surfacing gates. Borrowed in
 * spirit from `usageHue` in Settings.svelte (color carries
 * "how unusual is this row"; length still carries the magnitude),
 * but anchored to the absolute gate thresholds rather than the
 * dataset's median, because the gates are what determine
 * surfacing and they don't drift with the data.
 *
 *   0                       -> 220 (blue, no signal)
 *   CI_LB_SOFT (0.15)       -> 140 (green, edge of soft tier)
 *   CI_LB_STRONG (0.30)     ->  30 (orange, edge of strong tier)
 *   >= CI_LB_STRONG + 0.20  ->   5 (red, deep into strong)
 *
 * Linear interpolation between waypoints.
 */
export function biasHue(ciLower: number): number {
  if (ciLower <= 0) return 220;
  if (ciLower < CI_LB_SOFT) {
    const t = ciLower / CI_LB_SOFT;
    return 220 - t * 80;
  }
  if (ciLower < CI_LB_STRONG) {
    const t = (ciLower - CI_LB_SOFT) / (CI_LB_STRONG - CI_LB_SOFT);
    return 140 - t * 110;
  }
  const t = Math.min(1, (ciLower - CI_LB_STRONG) / 0.2);
  return 30 - t * 25;
}

/**
 * Denominator for the landscape bar's width. Always extends at
 * least to the strong-tier gate so the gate positions sit at a
 * consistent visual location even when no bias has cleared it
 * yet - otherwise a profile full of elided biases would stretch
 * the tiny CI-lower values to full width and lose the "look how
 * far we are from surfacing" read.
 */
export function chartScale(rows: readonly BiasSummaryDisplayRow[]): number {
  return Math.max(
    CI_LB_STRONG * 1.1,
    ...rows.map((r) => r.ciLower),
  );
}

/**
 * Width (in percent of the chart column) for one landscape bar.
 * `max(2%, share-of-scale)` so a non-zero but tiny CI lower still
 * registers as a visible nub rather than vanishing. No-evidence
 * rows are pinned to a fixed 1.5% gray nub - the ci_lower for
 * these is just prior + cumulative no-hit drift, so rendering it
 * at gate-relative position would imply signal that isn't there.
 * `scale` is the chartScale denominator, computed once per row
 * set by the caller.
 */
export function barWidthPct(
  ciLower: number,
  hasAnyEvidence: boolean,
  scale: number,
): number {
  if (!hasAnyEvidence) return 1.5;
  if (ciLower <= 0) return 0;
  return Math.max(2, (ciLower / scale) * 100);
}

/**
 * Empty-state copy for the "Observations from this conversation"
 * block, or null when the loaded observation list should render
 * instead. The null checks are the "sweep hasn't analyzed this
 * thread yet" state, which covers two cases that look the same
 * from the modal's perspective: (1) the thread is materialized
 * but still dated today (the day-gate defers it), and (2) the
 * thread is still a brand-new draft that hasn't been written to
 * the DB yet, in which case the observations query trivially
 * returns [] and would otherwise read as "already analyzed, no
 * findings" - wrong and misleading for a conversation that
 * hasn't even had its first message sent.
 */
export function currentObservationsEmptyCopy(
  obs: readonly unknown[] | null,
  processedAt: string | null,
): string | null {
  if (obs === null || processedAt === null) {
    return (
      'Not yet analyzed. Conversations become eligible once their ' +
      'last activity falls on a previous day; the hourly sweep picks ' +
      'this one up then.'
    );
  }
  if (obs.length === 0) {
    return (
      'Already analyzed - no clear bias evidence was found in this ' +
      'conversation. Reporting nothing is the correct answer most of ' +
      'the time.'
    );
  }
  return null;
}

/**
 * Empty-state copy for the "Reactions to compensation" block, or
 * null when the loaded reaction list should render instead. Same
 * "not yet analyzed" gating as `currentObservationsEmptyCopy`: an
 * empty reactions list on an un-processed thread is the sweep not
 * having gotten to it (or the thread being a draft that doesn't
 * exist in the DB yet), not "scanned and found nothing." When the
 * thread IS analyzed but empty, `activeBiasCount` (the size of
 * this turn's rendered set) picks between "nothing was active to
 * react to" and "the agent saw no clear signal."
 */
export function currentReactionsEmptyCopy(
  reactions: readonly unknown[] | null,
  processedAt: string | null,
  activeBiasCount: number,
): string | null {
  if (reactions === null || processedAt === null) {
    return (
      'Not yet analyzed. Reactions are recorded for the biases that ' +
      'were active in the system prompt while the conversation ' +
      'happened; the sweep classifies them once the conversation ' +
      'settles.'
    );
  }
  if (reactions.length > 0) return null;
  if (activeBiasCount === 0) {
    return (
      'No biases were active in the system prompt during this ' +
      'conversation, so there was nothing for you to react to.'
    );
  }
  return (
    'Already analyzed - the agent did not see a clear affirmation ' +
    'or pushback signal for the active biases on this conversation.'
  );
}

/**
 * Fallback for a thread title rendered as a clickable link in the
 * per-bias drill-down. A thread can reach the bias table before
 * the auto-title agent has produced anything; the bracketed
 * sentinel keeps the link scannable and unambiguous about what's
 * missing. Idiom matches `wiki-skipped-panel.ts:displayTitle` so
 * the two drill-down surfaces read the same way.
 */
export function displayThreadTitle(title: string | null): string {
  const trimmed = title?.trim();
  if (!trimmed) return '[untitled conversation]';
  return trimmed;
}

/**
 * Count-to-noun label for the "view N observations" toggle on a
 * per-bias evidence row. The count is the number of raw
 * `bias_observations` rows for this bias across the user's
 * history, not the number of distinct conversations - a single
 * conversation can produce multiple observations for the same
 * bias when the agent cites more than one evidentiary message.
 */
export function observationsLabel(n: number): string {
  return n === 1 ? '1 observation' : `${n} observations`;
}

/**
 * Hover-title copy for a tier badge. The badge itself shows only
 * the bare tier word ("elided" / "soft" / "strong"), which is
 * opaque without knowing the surfacing machinery; this expands it
 * into what the tier means and whether it reaches the system
 * prompt. Keyed off the same three-way `Tier` the gates produce
 * (see the tier rule in supabase/functions/_shared/bias-math.ts).
 */
export function tierTitle(tier: Tier): string {
  switch (tier) {
    case 'elided':
      return (
        'Elided: the 90% credible-interval lower bound sits below the ' +
        'soft gate, so the signal is too weak to surface. This bias is ' +
        'left out of the system prompt entirely.'
      );
    case 'soft':
      return (
        'Soft: an occasional pattern. The CI lower bound clears the soft ' +
        'gate but not the strong one - surfaces as a light "occasionally" ' +
        'nudge when it ranks high enough to make the system prompt.'
      );
    case 'strong':
      return (
        'Strong: a consistent pattern. The CI lower bound clears the ' +
        'strong gate - surfaces as a firm "consistently" note when it ' +
        'ranks high enough to make the system prompt.'
      );
  }
}

/**
 * Hover-title copy for the "in prompt" badge. Marks the rows that
 * actually rode into the assistant's system prompt this turn -
 * tier alone is not enough, since only the top entries by CI lower
 * are rendered (see `RENDER_CAP`).
 */
export const IN_PROMPT_TITLE =
  'This bias ranks in the top entries by CI lower this turn, so its ' +
  'compensation guidance is included in the assistant\'s system prompt ' +
  'right now.';

/**
 * Hover-title copy for a reaction verdict badge. The agent
 * classifies how the user responded to a surfaced bias
 * compensation; the badge shows only the bare verdict word, which
 * this expands. Three-state `was_confirmed`: true / false / null
 * map to affirmed / pushed back / neutral.
 */
export function reactionVerdictTitle(wasConfirmed: boolean | null): string {
  if (wasConfirmed === true) {
    return (
      'Affirmed: the agent read your reaction as confirming the bias ' +
      'compensation was apt. Counts as positive feedback, easing the ' +
      'gate toward surfacing this bias.'
    );
  }
  if (wasConfirmed === false) {
    return (
      'Pushed back: the agent read your reaction as rejecting the bias ' +
      'compensation. Counts as negative feedback, stiffening the gate ' +
      'against surfacing this bias.'
    );
  }
  return (
    'Neutral: the agent looked but saw no clear affirmation or pushback. ' +
    'Recorded for the record but does not move the feedback signal.'
  );
}
