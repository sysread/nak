/**
 * Window-level event bus for cross-surface notification of Library document
 * writes. Parallel to `wiki-events.ts`. Fired whenever a document is created,
 * updated, or deleted - by the user via Library.svelte or by the LLM via the
 * doc_create / doc_update / doc_delete tools. The drawer listing and the open
 * document panel both listen and refetch.
 *
 * Single-tab consistency only - Supabase realtime is not subscribed for
 * `documents`. A future realtime subscriber can fire this same event from
 * INSERT/UPDATE/DELETE without consumers changing.
 */
const DOCUMENT_CHANGE_EVENT = 'nak:document-change';

export function emitDocumentChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DOCUMENT_CHANGE_EVENT));
}

export function onDocumentChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(DOCUMENT_CHANGE_EVENT, listener);
  return () => window.removeEventListener(DOCUMENT_CHANGE_EVENT, listener);
}
