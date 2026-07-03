/**
 * UI-behavior primitives for the (valence x confidence) mood legend.
 * Pure functions only - no runes, no Svelte imports, no DOM access.
 * The companion `src/components/SamskaraMoodLegend.svelte` renders
 * the table; the domain data (MOOD_TABLE, the cell lookup math)
 * lives in `$lib/samskara/events` and is imported here so the
 * legend's range labels can never drift from the live mapping.
 */
import { MOOD_TABLE } from '../samskara/events';

// Comparison glyphs as escapes so the source stays ASCII.
const GE = '\u2265'; // greater-than-or-equal sign
const LE = '\u2264'; // less-than-or-equal sign

/**
 * Range label for MOOD_TABLE row i, e.g. "v >= 0.6",
 * "-0.2 <= v < 0.2", "v < -0.6". Depends on MOOD_TABLE being
 * ordered by descending valenceMin: each row's upper bound is the
 * previous row's lower bound, and the top row is unbounded above.
 * The bottom row's -Infinity sentinel renders as a plain
 * upper-bound-only label instead of leaking "-Infinity" to the user.
 */
export function valenceRangeLabel(i: number): string {
  const row = MOOD_TABLE[i];
  if (i === 0) return `v ${GE} ${row.valenceMin}`;
  const upper = MOOD_TABLE[i - 1].valenceMin;
  if (row.valenceMin === -Infinity) return `v < ${upper}`;
  return `${row.valenceMin} ${LE} v < ${upper}`;
}

/**
 * Compact single-bound variant for narrow viewports, where the
 * table drops to one bound per row: the lower bound normally, the
 * upper bound for the bottom (-Infinity) row.
 */
export function valenceRangeCompactLabel(i: number): string {
  const row = MOOD_TABLE[i];
  if (row.valenceMin === -Infinity) return `< ${MOOD_TABLE[i - 1].valenceMin}`;
  return `${GE} ${row.valenceMin}`;
}

/**
 * Aria-label for the "you are here" dot overlaying the current
 * mood cell. One template for both the confident and tentative
 * columns so the two dots always announce identically.
 */
export function moodDotAriaLabel(
  cellLabel: string,
  confidence: number,
  valence: number
): string {
  return `Pill currently here: ${cellLabel}, confidence ${confidence.toFixed(2)}, valence ${valence.toFixed(2)}`;
}
