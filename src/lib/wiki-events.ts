/**
 * Window-level event bus for cross-surface notification of wiki
 * writes. Parallel to `journal-events.ts`. Fired whenever a wiki
 * article is created/updated/deleted - by the user via Wiki.svelte,
 * by the LLM via the wiki_create/_update/_delete tools, or by the
 * autonomous wiki agent. The drawer listing and the open article
 * panel both listen and refetch.
 *
 * Single-tab consistency only - Supabase realtime is not subscribed
 * for `wiki_articles`. A future realtime subscriber can fire this
 * same event from INSERT/UPDATE/DELETE without consumers changing.
 */
export const WIKI_CHANGE_EVENT = 'nak:wiki-change';

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
