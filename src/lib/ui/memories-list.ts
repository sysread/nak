/**
 * UI-behavior primitives for the sidebar memory listing. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/MemoryList.svelte` composes these
 * with its own framework-native reactivity (the debounced
 * `$effect` that re-runs `runMemoriesSearch`, the `onMount` that
 * primes the topic vocabulary, the topic-filter mount).
 *
 * Topic filtering itself runs server-side via
 * `topicsFilterClause` in `supabase.ts` - the component just
 * writes the selection to `memoriesStore.selectedTopics` and the
 * next search picks it up. So unlike `recipe-list.ts`, this
 * module does NOT carry a client-side topic predicate; the
 * surface is smaller as a result.
 */

/**
 * Debounce window between the user's last keystroke and the
 * semantic-search round trip. Same value the recipe and wiki
 * listings use - typing-burst latency feels uniform across the
 * drawer tabs.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Message to render when the results list is empty. Two reasons
 * share the same rendering but communicate different things to
 * the user:
 *
 *   - active query, no hits - the search excluded everything;
 *     the right message is "No matches."
 *   - empty query, empty store - cold account; the message is
 *     the explainer that memories accumulate as the user chats.
 */
export function emptyMessage(query: string): string {
  return query.trim().length > 0
    ? 'No matches.'
    : 'No memories yet. They accumulate as you chat.';
}
