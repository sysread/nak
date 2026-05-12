<script lang="ts">
  /*
   * Sidebar recipe listing. Shown in the left drawer when the Recipes
   * tab is active. Provides search and sort controls; clicking a row
   * calls navigate({ recipe: id }) and switches the main panel to
   * RecipePanel.
   *
   * Empty query: shows `cookbook.recipes` (eagerly loaded by
   * cookbook-store), sorted by 'updated' or 'rating' per the picker.
   * Active query: fires an embed-then-search round trip via
   * `supabase.searchRecipes` so the closest-meaning recipe floats to
   * the top (semantic hits before ILIKE hits, dedup at the supabase
   * layer). While the request is in flight a Scanner replaces the
   * listing - the same shape the wiki and journal sidebars use.
   *
   * The sort picker is hidden during a search; relevance ordering is
   * the active sort in that mode, and the picker would be a confusing
   * no-op.
   */
  import { app } from '$lib/state.svelte';
  import { navigate, route } from '$lib/routing.svelte';
  import { cookbook } from '$lib/cookbook-store.svelte';
  import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '$lib/models';
  import type { Recipe } from '$lib/supabase';
  import RecipeRating from './RecipeRating.svelte';
  import Scanner from './Scanner.svelte';

  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  type SortMode = 'updated' | 'rating';
  let query = $state('');
  // 'updated' keeps the most-recently-edited recipe at the top;
  // 'rating' bubbles the user's favourites up. Matches the old modal.
  // Only consulted when query is empty; an active search uses
  // server-returned relevance order.
  let sortMode = $state<SortMode>('updated');

  let searchResults = $state<Recipe[]>([]);
  let searchBusy = $state(false);
  let searchError = $state<string | null>(null);
  let searchAbort: AbortController | null = null;

  const SEARCH_DEBOUNCE_MS = 200;
  const RECIPE_SEARCH_LIMIT = 50;

  $effect(() => {
    const q = query.trim();
    if (q.length === 0) {
      searchResults = [];
      searchBusy = false;
      searchError = null;
      if (searchAbort) searchAbort.abort();
      searchAbort = null;
      return;
    }
    if (!app.supabase) return;
    const timer = setTimeout(() => {
      void runRecipeSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  async function runRecipeSearch(q: string): Promise<void> {
    if (!app.supabase) return;
    // Supersede any in-flight call so a slow embed from a stale query
    // can't clobber a newer one.
    if (searchAbort) searchAbort.abort();
    const ctl = new AbortController();
    searchAbort = ctl;
    searchBusy = true;
    searchError = null;
    try {
      let queryEmbedding: number[] | null = null;
      if (app.venice) {
        try {
          const resp = await app.venice.embed({
            model: VENICE_EMBEDDING_MODEL,
            input: q,
            signal: ctl.signal,
          });
          const raw = resp.data[0]?.embedding;
          if (raw && raw.length > 0) {
            queryEmbedding = padEmbeddingForStorage(raw);
          }
        } catch {
          // Best-effort: ILIKE-only is still useful. searchRecipes
          // treats a null embedding as "skip the vector RPC".
        }
      }
      if (ctl.signal.aborted) return;
      const hits = await app.supabase.searchRecipes({
        query: q,
        queryEmbedding,
        limit: RECIPE_SEARCH_LIMIT,
      });
      if (ctl.signal.aborted) return;
      searchResults = hits;
    } catch (err) {
      if (!ctl.signal.aborted) {
        searchError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (searchAbort === ctl) {
        searchAbort = null;
        searchBusy = false;
      }
    }
  }

  const isSearching = $derived(query.trim().length > 0);

  const visibleRecipes = $derived.by<Recipe[]>(() => {
    if (isSearching) {
      // Server order wins during a search; the relevance ranking is
      // exactly what the user asked for.
      return searchResults;
    }
    if (sortMode === 'rating') {
      return [...cookbook.recipes].sort((a, b) => {
        const ar = a.rating ?? -1;
        const br = b.rating ?? -1;
        if (ar !== br) return br - ar;
        return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
      });
    }
    return cookbook.recipes;
  });
</script>

<div class="recipe-drawer-list">
  <div class="recipe-list-controls">
    <input
      type="search"
      class="sidebar-search-input"
      placeholder="Search recipes"
      aria-label="Search recipes"
      bind:value={query}
      autocomplete="off"
      spellcheck="false"
    />
    {#if !isSearching}
      <!-- Sort selector. 'Most recent' is the default to match the
           backing-store order; 'Rating' bubbles favourites up. Hidden
           during a search because relevance is the active sort then. -->
      <label class="recipe-sort-label" for="rl-sort">
        <span class="sr-only">Sort recipes</span>
        <select
          id="rl-sort"
          class="recipe-sort"
          bind:value={sortMode}
          aria-label="Sort recipes"
        >
          <option value="updated">Recent</option>
          <option value="rating">Rating</option>
        </select>
      </label>
    {/if}
  </div>
  {#if isSearching && searchBusy}
    <!-- Replace the listing with the K.I.T.T. scanner while the
         Venice embed + Supabase round-trip are in flight. -->
    <div class="search-status">
      <Scanner label="Searching recipes" size={0.9} />
    </div>
  {:else if isSearching && searchError}
    <p class="error" style="padding:0.75rem">
      Search failed: {searchError}
    </p>
  {:else if !isSearching && cookbook.loading && cookbook.recipes.length === 0}
    <div class="search-status">
      <Scanner label="Loading recipes" size={0.9} />
    </div>
  {:else if visibleRecipes.length === 0}
    <p class="subtle recipe-list-empty">
      {#if isSearching}
        No matches.
      {:else if cookbook.recipes.length === 0}
        No recipes yet. Use the panel to add one.
      {:else}
        No matches.
      {/if}
    </p>
  {:else}
    {#each visibleRecipes as r (r.id)}
      <div class="row thread-row" data-recipe-id={r.id}>
        <button
          class="thread grow recipe-list-row"
          class:active={route.recipe === r.id}
          aria-current={route.recipe === r.id ? 'true' : undefined}
          onclick={() => {
            navigate({ recipe: r.id });
            onSelect?.();
          }}
          title={r.title}
        >
          <span class="recipe-list-title">{r.title}</span>
          {#if r.rating !== null && r.rating !== undefined}
            <span class="recipe-list-rating">
              <RecipeRating value={r.rating} size={12} />
            </span>
          {/if}
        </button>
      </div>
    {/each}
  {/if}
</div>

<style>
  .recipe-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    /* Space below the divider so the first recipe row doesn't crowd
       the search input. Mirrors the chats / journal / memories tabs. */
    margin-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .recipe-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  .recipe-sort-label {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .recipe-sort {
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.8rem;
  }
  .recipe-list-empty {
    padding: 0.75rem;
  }
  /* Two-line recipe row: title on top, rating inline below. */
  .recipe-list-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
  }
  .recipe-list-title {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .recipe-list-rating {
    opacity: 0.8;
  }
</style>
