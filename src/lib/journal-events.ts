/**
 * Window-level event bus for cross-surface notification of journal
 * writes. Parallel to `cookbook-events.ts` - when a journal entry is
 * created/updated/deleted anywhere (user compose, tool call, worker
 * write), whatever surface cares (the Journal modal, a future
 * drawer listing) listens for the event and refetches.
 *
 * Keeping the store reactive alone would be enough within a single
 * tab, but Supabase realtime fan-out is not subscribed for this
 * table yet. The event bus gives us main-tab consistency cheaply; a
 * later realtime subscription can fire this same event from an
 * INSERT/UPDATE subscriber without the consumers needing to change.
 */
const JOURNAL_CHANGE_EVENT = 'nak:journal-change';

export function emitJournalChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(JOURNAL_CHANGE_EVENT));
}

export function onJournalChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(JOURNAL_CHANGE_EVENT, listener);
  return () => window.removeEventListener(JOURNAL_CHANGE_EVENT, listener);
}
