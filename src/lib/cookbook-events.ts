/**
 * Rune-free side of the cookbook bridge - the `window` CustomEvent name
 * and the subscribe helper live here (plain .ts, no `$state`) so any
 * caller can import them without pulling runes into a non-UI bundle.
 *
 * The reactive store half lives in `cookbook-store.svelte.ts`;
 * Chat.svelte's listener reacts to these events by reloading the
 * store's recipe list (onCookbookStoreChanged). Keep any `$state` /
 * `$derived` / `$effect` rune code OUT of this file.
 *
 * The publisher is the recipes-table realtime relay in Chat.svelte
 * (SupabaseService.subscribeToRecipeChanges -> emitCookbookChange).
 * Every recipe writer reachable from chat lives in the venice edge
 * function now, so the replication stream is the writer-of-record
 * notification path for model-driven saves. Direct UI edits in
 * Cookbook.svelte refresh their own local state and never needed this
 * bus; their writes may also echo back through the relay, which is
 * harmless because subscribers refetch idempotently.
 */

const COOKBOOK_CHANGE_EVENT = 'nak:recipes:changed';

export function emitCookbookChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(COOKBOOK_CHANGE_EVENT));
}

/**
 * Subscribe to COOKBOOK_CHANGE_EVENT. Returns an `off` callback that
 * removes the listener; intended for use inside `$effect` blocks that
 * want a single returned cleanup. Mirrors `onWikiChange` in
 * `wiki-events.ts`. No-op + no-op cleanup when `window` is
 * undefined so SSR / worker contexts compile without guarding the
 * call site.
 */
export function onCookbookChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(COOKBOOK_CHANGE_EVENT, listener);
  return () => window.removeEventListener(COOKBOOK_CHANGE_EVENT, listener);
}

/**
 * Separate channel for recipe-record writes (the dated entries in a
 * recipe's cooking log). Kept distinct from COOKBOOK_CHANGE_EVENT so a
 * record write refetches only the open recipe's Records section, not
 * the whole cookbook listing. Fired by the Records section's own
 * compose/edit/delete writes after they succeed, and by the
 * recipe_records realtime subscription relaying server-side writes
 * (the recipe_record_* chat tools; see
 * SupabaseService.subscribeToRecipeRecordChanges, wired in
 * Chat.svelte). RecipeRecords.svelte listens and refetches.
 */
const RECIPE_RECORD_CHANGE_EVENT = 'nak:recipe-records:changed';

export function emitRecipeRecordChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(RECIPE_RECORD_CHANGE_EVENT));
}

export function onRecipeRecordChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(RECIPE_RECORD_CHANGE_EVENT, listener);
  return () => window.removeEventListener(RECIPE_RECORD_CHANGE_EVENT, listener);
}
