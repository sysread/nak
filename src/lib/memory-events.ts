/**
 * Window-level event bus for cross-surface notification of memory
 * writes. Parallel to `wiki-events.ts`. Emitters: the Memories
 * panel's direct edits, the manual librarian strip
 * (memory-librarian-run.svelte.ts) when a run finishes, and the
 * realtime relay in Chat.svelte
 * (SupabaseService.subscribeToMemoryChanges -> emitMemoryChange),
 * which is how the server-side writers - reflection, the chat-facing
 * memory tools, the rem and deep-sleep librarian passes - reach an
 * open panel. The Memories panel and sidebar re-run their search to
 * refresh; the MemoryChangelogPanel reloads its first page so a
 * write that lands while the panel is open shows up without a
 * manual refresh.
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
