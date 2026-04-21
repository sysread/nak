/**
 * Rune-free side of the cookbook bridge. The event name constant
 * and the fire-and-forget dispatcher live here (plain .ts) so the
 * `recipe_*` tools — which get bundled into non-UI contexts like
 * the reflection Web Worker via the shared tool registry — can
 * signal "cookbook changed" without pulling `$state` into a worker
 * bundle.
 *
 * The reactive store half lives in `cookbook-store.svelte.ts`; it
 * re-exports the symbols here so existing UI imports keep working.
 * Keep any `$state` / `$derived` / `$effect` rune code OUT of this
 * file — the whole point of the split is that a worker can import
 * it safely.
 */

export const COOKBOOK_CHANGE_EVENT = 'nak:recipes:changed';

/**
 * Fire-and-forget signal that something in the cookbook changed.
 * Called from `recipe_*` tool handlers after a successful write.
 * Listeners (the Cookbook modal, the drawer's Recipes tab) respond
 * by re-running `loadRecipes`. No-op when `window` is undefined —
 * the tool registry is reachable from the reflection worker, which
 * has `self` but no `window`, and from SSR contexts that have
 * neither.
 */
export function notifyCookbookChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(COOKBOOK_CHANGE_EVENT));
}
