/**
 * Window-level event bus for cross-surface notification of memory
 * writes. Parallel to `wiki-events.ts`. Emitters: the memory librarian
 * agents (deep-sleep and rem), which write to memories /
 * memory_relations / memory_conversation directly via supabase, and
 * the content-write tools (memory_create / _update / _delete /
 * _consolidate) which fire it after appending their changelog row. The
 * Memories panel and sidebar re-run their search to refresh; the
 * MemoryChangelogPanel reloads its first page so a write that lands
 * while the panel is open shows up without a manual refresh.
 *
 * Single-tab consistency only - Supabase realtime is not subscribed
 * for memory tables. A future realtime subscriber can fire this
 * event on INSERT/UPDATE/DELETE without consumers changing.
 */
const MEMORY_CHANGE_EVENT = 'nak:memory-change';

export function emitMemoryChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MEMORY_CHANGE_EVENT));
}

export function onMemoryChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(MEMORY_CHANGE_EVENT, listener);
  return () => window.removeEventListener(MEMORY_CHANGE_EVENT, listener);
}
