/**
 * Rune-free side of the cookbook bridge - the `window` CustomEvent name
 * and the subscribe helper live here (plain .ts, no `$state`) so any
 * caller can import them without pulling runes into a non-UI bundle.
 *
 * The reactive store half lives in `cookbook-store.svelte.ts`; it
 * re-exports the symbols here so existing UI imports keep working.
 * Keep any `$state` / `$derived` / `$effect` rune code OUT of this
 * file.
 *
 * Publisher gap: recipe writes now run in the venice edge function
 * (the browser `recipe_*` tools that used to dispatch this event on a
 * successful write moved server-side), so there is currently no
 * browser-side publisher of COOKBOOK_CHANGE_EVENT. `onCookbookChange`
 * stays because the Cookbook modal and the drawer's Recipes tab still
 * subscribe; re-driving a refresh after a chat-driven recipe write
 * wants a server-aware trigger (e.g. a recipes-table Realtime
 * subscription), which is separate work.
 */

const COOKBOOK_CHANGE_EVENT = 'nak:recipes:changed';

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
