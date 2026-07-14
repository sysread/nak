/**
 * Rune-free side of the grocery bridge - the `window` CustomEvent name
 * and the subscribe helper (plain .ts, no `$state`) so any caller can
 * import them without pulling runes into a non-UI bundle. Mirrors
 * `cookbook-events.ts`.
 *
 * The publisher is the grocery realtime relay in Chat.svelte
 * (SupabaseService.subscribeToGroceryChanges -> emitGroceryChange).
 * The relay is how server-originated writes reach an open Groceries
 * tab: the recipe-edit invalidation trigger's bulk delete and a second
 * device's edits both land only in the replication stream. Local UI
 * writes refresh their own store state directly; their echo back
 * through the relay is harmless because subscribers refetch
 * idempotently.
 */

const GROCERY_CHANGE_EVENT = 'nak:grocery:changed';

export function emitGroceryChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(GROCERY_CHANGE_EVENT));
}

/**
 * Subscribe to GROCERY_CHANGE_EVENT. Returns an `off` callback that
 * removes the listener; intended for use inside `$effect` blocks that
 * want a single returned cleanup. No-op + no-op cleanup when `window`
 * is undefined so SSR / worker contexts compile without guarding the
 * call site.
 */
export function onGroceryChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(GROCERY_CHANGE_EVENT, listener);
  return () => window.removeEventListener(GROCERY_CHANGE_EVENT, listener);
}
