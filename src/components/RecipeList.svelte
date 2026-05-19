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
  import {
    cookbook,
    refreshRecipesTopicsVocabulary,
  } from '$lib/cookbook-store.svelte';
  import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '$lib/models';
  import type { Recipe } from '$lib/supabase';
  import {
    RECIPE_SEARCH_LIMIT,
    SEARCH_DEBOUNCE_MS,
    type SortMode,
    computeListView,
    isSearching as isSearchingFn,
    pickFavoriteRecipes,
    pickUpcomingRecipes,
    pickVisibleRecipes,
  } from '$lib/ui/recipe-list';
  import { onMount } from 'svelte';
  import RecipeRating from './RecipeRating.svelte';
  import Scanner from './Scanner.svelte';
  import BucketHeader from './BucketHeader.svelte';
  import TopicsFilter from './TopicsFilter.svelte';

  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  let query = $state('');
  // 'updated' keeps the most-recently-edited recipe at the top;
  // 'rating' bubbles the user's favourites up; 'alphabetical'
  // sorts by title for when you remember the name but not when
  // you last touched it. Only consulted when query is empty; an
  // active search uses server-returned relevance order.
  let sortMode = $state<SortMode>('updated');

  let searchResults = $state<Recipe[]>([]);
  let searchBusy = $state(false);
  let searchError = $state<string | null>(null);
  let searchAbort: AbortController | null = null;

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

  // Prime the topic-filter vocabulary as soon as the drawer opens.
  // `loadRecipes` also chains this in, but onMount covers the case
  // where the drawer is opened after recipes were eagerly loaded
  // elsewhere (e.g. via a tool call that already refreshed the
  // store).
  onMount(() => {
    if (!app.supabase) return;
    void refreshRecipesTopicsVocabulary(app.supabase);
  });

  function setTopics(next: string[]): void {
    cookbook.selectedTopics = next;
  }

  const searching = $derived(isSearchingFn(query));
  const visibleRecipes = $derived(
    pickVisibleRecipes({
      searching,
      searchResults,
      storeRecipes: cookbook.recipes,
      sortMode,
      selectedTopics: cookbook.selectedTopics,
    })
  );
  const upcomingRecipes = $derived(
    pickUpcomingRecipes(
      cookbook.recipes,
      searching,
      cookbook.selectedTopics
    )
  );
  const favoriteRecipes = $derived(
    pickFavoriteRecipes(
      cookbook.recipes,
      searching,
      cookbook.selectedTopics
    )
  );
  const view = $derived(
    computeListView({
      searching,
      searchBusy,
      searchError,
      storeLoading: cookbook.loading,
      storeCount: cookbook.recipes.length,
      visibleCount: visibleRecipes.length,
    })
  );
</script>

<div class="recipe-drawer-list">
  <div class="recipe-list-controls">
    <input
      type="search"
      name="recipe-search"
      class="sidebar-search-input"
      placeholder="Search recipes"
      aria-label="Search recipes"
      bind:value={query}
      autocomplete="off"
      spellcheck="false"
    />
    {#if !searching}
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
          <option value="alphabetical">A-Z</option>
        </select>
      </label>
    {/if}
  </div>
  <!-- Topic-filter row. Sits below the search input and above the
       listing. Applied client-side over the bounded cookbook so the
       same predicate narrows Upcoming, Favorites, search results, and
       the main listing uniformly. -->
  <div class="recipe-list-topics">
    <TopicsFilter
      topics={cookbook.topicsVocabulary}
      selected={cookbook.selectedTopics}
      onChange={setTopics}
    />
  </div>
  {#if view.kind === 'scanner-search'}
    <!-- Replace the listing with the K.I.T.T. scanner while the
         Venice embed + Supabase round-trip are in flight. -->
    <div class="search-status">
      <Scanner label="Searching recipes" size={0.9} />
    </div>
  {:else if view.kind === 'error'}
    <p class="error" style="padding:0.75rem">
      Search failed: {view.message}
    </p>
  {:else if view.kind === 'scanner-loading'}
    <div class="search-status">
      <Scanner label="Loading recipes" size={0.9} />
    </div>
  {:else if view.kind === 'empty'}
    <p class="subtle recipe-list-empty">
      {#if view.reason === 'no-recipes-yet'}
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
            {#if r.favorite}
              <!-- Thumbs-up glyph: parallel to the cart - present on
                   the row in BOTH the Favorites section AND its natural
                   slot in the main list, so a favorited row in the main
                   list is visibly marked too. -->
              <span
                class="recipe-list-favorite-mark"
                aria-label="Favorite"
                title="Favorite"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round"
                     stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3z" />
                  <path d="M7 11l4-7a2 2 0 0 1 4 0v4h5a2 2 0 0 1 2 2.4l-2 7A2 2 0 0 1 18 20H7z" />
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
      <BucketHeader label="Upcoming" />
      {#each upcomingRecipes as r (`upcoming:${r.id}`)}
        {@render recipeRow(r, { keyPrefix: 'upcoming' })}
      {/each}
    {/if}
    {#if favoriteRecipes.length > 0}
      <BucketHeader label="Favorites" flourish={upcomingRecipes.length > 0} />
      {#each favoriteRecipes as r (`favorite:${r.id}`)}
        {@render recipeRow(r, { keyPrefix: 'favorite' })}
      {/each}
    {/if}
    {#if upcomingRecipes.length > 0 || favoriteRecipes.length > 0}
      <!-- Divider header for the main listing. Without it, the main
           list would visually run into whichever section is directly
           above. Only shown when at least one bucket section is
           present - otherwise the main list IS the whole listing and
           a header would just be noise. The flourish lands above this
           header because at least one prior section is in play. -->
      <BucketHeader label="All recipes" flourish />
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
    /* Space below the search row so the first recipe row doesn't crowd
       the search input. Mirrors the chats / memories / wiki tabs. */
    margin-bottom: 0.5rem;
  }
  .recipe-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  /* Topic-filter row. Sits below the search row and aligns to the
     same content gutters: the controls row's padding-x is 0.6rem, so
     this row's margin-x matches so the Topics trigger's left and
     right edges line up with the search input's left edge and the
     Recent dropdown's right edge respectively. Mirrors
     `.memory-list-topics`. Negative margin-top tucks the trigger
     close under the controls row; bottom margin separates from the
     first listing entry. */
  .recipe-list-topics {
    margin: -0.3rem 0.6rem 0.5rem;
    flex-shrink: 0;
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
  /* Thumbs-up glyph for favorited rows. Parallel to the upcoming
     mark; sits to the right of it when a row is flagged for both
     (cart, then thumbs-up, then title). Same accent tint so the row
     reads as "marked" without picking a competing color. */
  .recipe-list-favorite-mark {
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
