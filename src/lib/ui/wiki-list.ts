/**
 * UI-behavior primitives for the sidebar wiki listing. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/WikiList.svelte` composes these
 * with its own framework-native reactivity (the debounced
 * `$effect` that re-runs `runWikiSearch`, the markup, and the
 * Scanner mount).
 *
 * Type imports from `$lib/supabase` carry the `WikiArticle`
 * shape; a port to another framework would consume it
 * unchanged.
 */
import type { WikiArticle } from '../supabase';

/**
 * Debounce window between the user's last keystroke and the
 * semantic-search round trip. Same value the recipe and memory
 * listings use - typing-burst latency feels uniform across the
 * drawer tabs.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Sort decision for the listing area:
 *
 *   - Empty query - alphabetical by title (case-insensitive),
 *     so the drawer reads as a wiki listing rather than a
 *     recency ranking. The wiki is meant to be browsed by topic.
 *   - Active query - pass server order through verbatim. The
 *     semantic-search RPC returns hits in ascending cosine
 *     distance (closest first), then ILIKE hits the vector
 *     pass missed. That's what "ordered by closest match"
 *     means here.
 *
 * Returns a fresh array; the input store reference is never
 * mutated.
 */
export function pickSortedArticles(args: {
  articles: readonly WikiArticle[];
  query: string;
}): WikiArticle[] {
  if (args.query.trim().length > 0) return [...args.articles];
  return [...args.articles].sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  );
}

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
