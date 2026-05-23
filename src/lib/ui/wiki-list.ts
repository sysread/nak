/**
 * UI-behavior primitives for the sidebar wiki listing. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/WikiList.svelte` composes these
 * with its own framework-native reactivity (the debounced
 * `$effect` that re-runs `runWikiSearch`, the infinite-scroll
 * sentinel that pages the browse list, the markup, and the
 * Scanner mount). The listing itself is rendered in server
 * order - title ASC for browse, relevance for search - so there
 * is no client-side sort primitive here.
 */

/**
 * Debounce window between the user's last keystroke and the
 * semantic-search round trip. Same value the recipe and memory
 * listings use - typing-burst latency feels uniform across the
 * drawer tabs.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Scanner-label decision. Both states render the K.I.T.T.
 * scanner during an in-flight request, but the framing differs -
 * "Searching wiki" when the user typed something, "Loading wiki"
 * for the initial empty-query refresh on mount.
 */
export function scannerLabel(query: string): string {
  return query.trim().length > 0 ? 'Searching wiki' : 'Loading wiki';
}

/**
 * Message to render when the listing is empty. Two reasons share
 * the same rendering but communicate different things:
 *
 *   - active query, no hits - "No matches."
 *   - empty query, empty store - the explainer that the
 *     background agent writes articles as the user chats, and
 *     direct authoring is also available.
 */
export function emptyMessage(query: string): string {
  return query.trim().length > 0
    ? 'No matches.'
    : 'No wiki articles yet. The background agent writes them as you chat, or you can add your own.';
}
