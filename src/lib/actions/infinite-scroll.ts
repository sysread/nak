/**
 * Svelte `use:` action that fires `onHit` when a sentinel element
 * scrolls into view, driving the "load the next page" step of the
 * offset-paginated browse lists (RecipeList, MemoryList, WikiList
 * sidebars).
 *
 * DOM glue, not a pure UI primitive - it owns an IntersectionObserver
 * keyed to a real node - so it lives here rather than in
 * `src/lib/ui/`. Callers mount the sentinel under an `{#if hasMore}`
 * block so the node unmounts (and the observer disconnects) the moment
 * the list is drained; remounting on the next refill re-arms the
 * action without any explicit enable/disable wiring.
 *
 * `onHit` is read live on each intersection, so a component can hand
 * over a closure that calls into its current store state without
 * re-running the action when the closure identity changes.
 *
 * `rootMargin` defaults to 200px so the fetch starts a screenful
 * before the sentinel is actually visible - the same lookahead the
 * thread drawer's sentinels use, so paging feels seamless rather than
 * "scroll, wait, scroll."
 */
import type { Action } from 'svelte/action';

interface InfiniteScrollParams {
  onHit: () => void;
  rootMargin?: string;
}

export const infiniteScroll: Action<HTMLElement, InfiniteScrollParams> = (
  node,
  params
) => {
  let current = params;

  // No IntersectionObserver (old browser, or a non-DOM test env): the
  // list still works, it just won't auto-page. Bail without throwing
  // so the sidebar renders the rows it already has.
  if (typeof IntersectionObserver === 'undefined') {
    return {
      update(next: InfiniteScrollParams) {
        current = next;
      },
    };
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) current.onHit();
      }
    },
    { rootMargin: params.rootMargin ?? '200px 0px', threshold: 0 }
  );
  observer.observe(node);

  return {
    update(next: InfiniteScrollParams) {
      current = next;
    },
    destroy() {
      observer.disconnect();
    },
  };
};
