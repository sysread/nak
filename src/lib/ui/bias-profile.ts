/**
 * UI-behavior primitives for the bias-profile diagnostics modal.
 * Pure functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/screens/BiasProfile.svelte` composes these with
 * its own framework-native reactivity (state runes, supabase
 * fetch orchestration, navigation patches, and the markup).
 */

/**
 * Fallback for a thread title rendered as a clickable link in the
 * per-bias drill-down. A thread can reach the bias table before
 * the auto-title worker has produced anything; the bracketed
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
