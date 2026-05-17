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
   * listing - the same shape the wiki sidebar uses.
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

  // Upcoming recipes surface in a section at the top regardless of the
  // active sort, then ALSO continue to appear in their natural position
  // in the main listing below. The duplication is intentional - the
  // user wants "what's coming up this shopping cycle" as a quick read
  // without losing the recipe from its normal spot. Hidden during a
  // search because the relevance ranking is what the user asked for
  // and a bucket above it would just visually fight the result order.
  // Sort within the section by updated_at desc so the most recently
  // edited upcoming recipe sits first - matches the "Recent" bucket in
  // the conversations drawer.
  const upcomingRecipes = $derived.by<Recipe[]>(() => {
    if (isSearching) return [];
    return cookbook.recipes
      .filter((r) => r.upcoming)
      .sort((a, b) =>
        (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
      );
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
    {#snippet recipeRow(r: Recipe, opts?: { keyPrefix?: string })}
      <div
        class="row thread-row"
        data-recipe-id={r.id}
        data-recipe-key={opts?.keyPrefix ? `${opts.keyPrefix}:${r.id}` : r.id}
      >
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
          <span class="recipe-list-title">
            {#if r.upcoming}
              <!-- Cart glyph: the user marked this for the current
                   grocery-shopping cycle. Shown in BOTH the Upcoming
                   section above AND the row's natural spot in the
                   main list, so the user can tell at a glance which
                   "regular" rows are also in the bookmark set. -->
              <span
                class="recipe-list-upcoming-mark"
                aria-label="Upcoming"
                title="Upcoming"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round"
                     stroke-linejoin="round" aria-hidden="true">
                  <circle cx="9" cy="21" r="1" />
                  <circle cx="20" cy="21" r="1" />
                  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                </svg>
              </span>
            {/if}
            {r.title}
          </span>
          {#if r.rating !== null && r.rating !== undefined}
            <span class="recipe-list-rating">
              <RecipeRating value={r.rating} size={12} />
            </span>
          {/if}
        </button>
      </div>
    {/snippet}

    {#if upcomingRecipes.length > 0}
      <h3 class="bucket-header">Upcoming</h3>
      {#each upcomingRecipes as r (`upcoming:${r.id}`)}
        {@render recipeRow(r, { keyPrefix: 'upcoming' })}
      {/each}
      <!-- Divider between the Upcoming section and the main listing.
           Without a header on the main section the second list would
           visually run into the first; the "All recipes" header makes
           the split explicit. Only shown when the Upcoming bucket has
           content - otherwise the main list is the whole listing and
           a header would just be noise. -->
      <h3 class="bucket-header">All recipes</h3>
    {/if}
    {#each visibleRecipes as r (r.id)}
      {@render recipeRow(r)}
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
       the search input. Mirrors the chats / memories / wiki tabs. */
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
  /* Inline cart glyph that prefixes the title of any upcoming recipe.
     Tinted with --accent so it reads as a "marked" affordance against
     the rest of the row. The mark appears on the row in BOTH the
     Upcoming section above and the main listing below so the user
     can spot at a glance which "regular" rows are also bookmarked. */
  .recipe-list-upcoming-mark {
    display: inline-flex;
    align-items: center;
    color: var(--accent);
    margin-right: 0.3rem;
    vertical-align: -0.1em;
  }
  .recipe-list-rating {
    opacity: 0.8;
  }
</style>
