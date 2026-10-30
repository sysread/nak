/**
 * UI-behavior primitives for the sidebar skills listing. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/SkillList.svelte` composes these with
 * its own framework-native reactivity (the debounced `$effect` that
 * re-runs `runSkillsSearch`, the infinite-scroll sentinel, the
 * markup).
 *
 * The listing renders in server order (name ASC for both browse
 * and search - there is no ranking layer) - no client re-sort, same
 * rationale as the wiki and memories listings.
 */

/**
 * Debounce window between the user's last keystroke and the search
 * round trip. Each feature module declares its own copy of this
 * constant - that is the established convention (recipe / memory /
 * wiki listings all carry one), not an accident to deduplicate.
 * Same value everywhere so typing-burst latency feels uniform
 * across the drawer tabs.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Row snippet ceiling. Rows show name + a one-line description
 * snippet; the description is what tells the model when the skill
 * applies, so showing it lets the user judge relevance without
 * opening the row. Long enough to carry a real clause, short enough
 * that two rows stay scannable.
 */
export const ROW_SNIPPET_CHARS = 90;

/**
 * Message to render when the listing is empty. Two reasons share
 * the same rendering but communicate different things:
 *
 *   - active query, no hits - the search excluded everything;
 *     the right message is "No matches."
 *   - empty query, empty store - cold account; the message points
 *     at the create affordance on the panel.
 */
export function emptyMessage(query: string): string {
  return query.trim().length > 0
    ? 'No matches.'
    : 'No skills yet. Create one with the New skill button.';
}

/**
 * One-line snippet of a skill description for the sidebar row.
 * Descriptions are model-authored and may contain newlines; the row
 * is single-line, so runs of whitespace (including newlines)
 * collapse to single spaces before the length cut. Truncation uses
 * three plain dots to stay ASCII-honest with the rest of the row.
 */
export function rowSnippet(description: string): string {
  const collapsed = description.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= ROW_SNIPPET_CHARS) return collapsed;
  return `${collapsed.slice(0, ROW_SNIPPET_CHARS - 3)}...`;
}
