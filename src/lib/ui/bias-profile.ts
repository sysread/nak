/**
 * UI-behavior primitives for the bias-profile diagnostics modal.
 * Pure functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/screens/BiasProfile.svelte` composes these with
 * its own framework-native reactivity (state runes, supabase
 * fetch orchestration, navigation patches, and the markup).
 */

import type { Tier } from '$lib/bias/types';

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
