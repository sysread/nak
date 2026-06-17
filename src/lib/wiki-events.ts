/**
 * Window-level event bus for cross-surface notification of wiki
 * writes. Parallel to `cookbook-events.ts`. Fired whenever a wiki
 * article is created/updated/deleted - by the user via Wiki.svelte,
 * or by the wiki_articles realtime subscription relaying a
 * server-side write (the autonomous wiki agent and the wiki
 * librarian both run in the venice function; see
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

/**
 * Separate channel for wiki-record writes (the dated entries linked to
 * an article). Kept distinct from WIKI_CHANGE_EVENT so a record write
 * refetches only the open article's Records section, not the whole
 * article drawer listing. Fired by the in-app compose form and by the
 * wiki_records realtime subscription relaying server-side writes (the
 * extraction agent, the librarian, the chat record tools; see
 * SupabaseService.subscribeToWikiRecordChanges).
 */
const WIKI_RECORD_CHANGE_EVENT = 'nak:wiki-record-change';

export function emitWikiRecordChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WIKI_RECORD_CHANGE_EVENT));
}

export function onWikiRecordChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(WIKI_RECORD_CHANGE_EVENT, listener);
  return () => window.removeEventListener(WIKI_RECORD_CHANGE_EVENT, listener);
}
