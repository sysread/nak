/**
 * UI-behavior primitives for the Samskara Health panel
 * (src/components/SamskaraHealthPanel.svelte): the severity
 * classification and its thresholds, the compound-summary regen
 * status, the panel headline, and the health-side count labels.
 * Pure functions only - no runes, no Svelte imports, no DOM.
 *
 * The browse/detail primitives (list constants, collapse, provenance
 * grouping, per-samskara verdict list) live in the sibling
 * ./samskara-browse.ts; the health panel also reads that module's
 * `relativeTime` directly. The shared VerdictCount row shape is
 * imported from there so the two verdict lists render identically.
 */
import type { VerdictCount } from './samskara-browse';

export type Severity = 'ok' | 'warn' | 'alarm';

/**
 * Thresholds for the Health panel's severity classification. Starting
 * defaults - tune against observed pipeline behaviour. Each pair is
 * [warn-at, alarm-at]: a value >= alarm-at is 'alarm', >= warn-at is
 * 'warn', else 'ok'.
 *
 * Backlogs only matter when they're DEEP and persistent: the workers run
 * client-side, so a backlog accumulates while no tab is open and drains
 * when one is - a snapshot of a few pending rows is normal, not a stall.
 * Hence the loose [50, 500] bars. Orphans and stuck claims, by contrast,
 * should be ~0 regardless of worker scheduling, so their bars are tight.
 *
 * Deliberately NOT here: a "fires aged out unresolved" bar. That count
 * grows unbounded by design - reaction-classify only ever resolves the
 * cohort whose follow-up landed in the 1-10min window, so ~95% of fires
 * age out unresolved forever. Flagging it as a failure is a false alarm
 * (it was the original cause of a permanent "something is stuck").
 */
export const HEALTH_THRESHOLDS = {
  pendingAssimilate: [50, 500],
  pendingEmbed: [50, 500],
  orphanFires: [1, 5],
  stuckClaims: [1, 3],
} as const satisfies Record<string, readonly [number, number]>;

/** Classify a backlog/inconsistency count against a [warn, alarm] pair. */
export function severityFor(value: number, thresholds: readonly [number, number]): Severity {
  if (value >= thresholds[1]) return 'alarm';
  if (value >= thresholds[0]) return 'warn';
  return 'ok';
}

export interface CompoundRegenStatus {
  /** Severity for the headline dot. */
  sev: Severity;
  /** New samskaras formed since the last regen (the event-arm value). */
  delta: number;
  /** Count at which the background regen fires (the log10-damped bar). */
  threshold: number;
}

/**
 * Compound-summary regen status, derived from the SAME predicate the
 * background regen uses (schema.sql `samskara_should_regen_compound`),
 * NOT wall-clock age.
 *
 * Age alone is a false positive: the summary only regenerates when the
 * hourly sweep visits a user, and the sweep only fans out to users with
 * substrate/fire activity in the last couple of hours
 * (SWEEP_USER_WINDOW_HOURS). An idle account's summary therefore drifts
 * arbitrarily far past the predicate's 6h window with nothing wrong and
 * nothing to do - an age>=6h/>=24h dot lit amber/red on exactly that
 * benign case.
 *
 * The actionable arm is the event count: samskaras formed since the last
 * regen, against the log10-damped threshold. Unlike age, the delta only
 * grows while the user is active - which is precisely when the sweep can
 * act on it - so a delta stuck past the bar is a real "the sweep isn't
 * keeping up" signal, not an idle-time artifact.
 *
 * threshold = max(3, ceil(5 * log10(total + 10))), mirroring the SQL.
 * Both sides are base-10: JS `Math.log10` equals Postgres unary `log()`
 * (NOT `ln()`); see the base-10 caution in the SQL function. Due at
 * >= threshold (warn); escalates to alarm at >= 2x threshold, where
 * "due but unmet" stops reading as "the next sweep will catch it".
 */
export function compoundRegenStatus(
  totalSamskaras: number,
  samskaraCountAtRegen: number,
  hasSummary: boolean,
): CompoundRegenStatus {
  const threshold = Math.max(3, Math.ceil(5 * Math.log10(totalSamskaras + 10)));
  // No summary yet is mild, not an alarm: the normal resting state of a
  // corpus that hasn't formed enough samskaras to prime the first regen.
  // Mirrors the predicate's `last_regen_at is null and count > 0` arm.
  if (!hasSummary) {
    return { sev: totalSamskaras > 0 ? 'warn' : 'ok', delta: totalSamskaras, threshold };
  }
  const delta = Math.max(0, totalSamskaras - samskaraCountAtRegen);
  const sev: Severity = delta >= 2 * threshold ? 'alarm' : delta >= threshold ? 'warn' : 'ok';
  return { sev, delta, threshold };
}

/**
 * Worst severity across a set - for a single panel-level headline dot.
 * 'alarm' dominates 'warn' dominates 'ok'.
 */
export function worstSeverity(severities: readonly Severity[]): Severity {
  if (severities.includes('alarm')) return 'alarm';
  if (severities.includes('warn')) return 'warn';
  return 'ok';
}

/**
 * Headline copy for the Health panel's overall severity dot. One
 * phrase per severity tier; the dot itself carries the color.
 */
export function healthHeadline(overall: Severity): string {
  if (overall === 'ok') return 'Pipeline healthy';
  if (overall === 'warn') return 'Needs a look';
  return 'Something is stuck';
}

/**
 * The judged-fire verdict breakdown as a labelled list, in the order
 * the Health panel stacks them. Extracted so the panel iterates a
 * vertical list rather than interpolating three slash-separated counts
 * on one line - that line wrapped mid-slash and read as jarring on
 * narrow (mobile) viewports.
 */
export function verdictBreakdown(rates: {
  held: number;
  contradicted: number;
  notBorneOut: number;
  notEngaged: number;
}): VerdictCount[] {
  return [
    { label: 'held', count: rates.held },
    { label: 'contradicted', count: rates.contradicted },
    { label: 'not-borne-out', count: rates.notBorneOut },
    { label: 'not-engaged', count: rates.notEngaged },
  ];
}

/**
 * Health-panel readout for the tier-2 detector: how many tier-1 members
 * it would currently hand the minter. Size is 0 (nothing offerable) or
 * >= the minter's 3-member floor; the singular branch is defensive.
 */
export function tier2CandidateLabel(size: number): string {
  if (size <= 0) return 'none available';
  return `available (${size} member${size === 1 ? '' : 's'})`;
}

/** "N samskara" / "N samskaras" - the compound-summary coverage caption. */
export function samskaraCountPhrase(count: number): string {
  return `${count} samskara${count === 1 ? '' : 's'}`;
}
