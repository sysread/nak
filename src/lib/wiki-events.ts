/**
 * Window-level event bus for cross-surface notification of wiki
 * writes. Parallel to `cookbook-events.ts`. Fired whenever a wiki
 * article is created/updated/deleted - by the user via Wiki.svelte,
 * by the still-browser wiki librarian's tools, or by the
 * wiki_articles realtime subscription relaying a server-side write
 * (the autonomous wiki agent runs in the venice function now; see
 * SupabaseService.subscribeToWikiArticleChanges and its wiring in
 * Chat.svelte). The drawer listing and the open article panel both
 * listen and refetch.
 */
const WIKI_CHANGE_EVENT = 'nak:wiki-change';

export function emitWikiChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WIKI_CHANGE_EVENT));
}

export function onWikiChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(WIKI_CHANGE_EVENT, listener);
  return () => window.removeEventListener(WIKI_CHANGE_EVENT, listener);
}
