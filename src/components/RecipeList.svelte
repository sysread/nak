<script lang="ts">
  /*
   * Sidebar recipe listing. Shown in the left drawer when the Recipes
   * tab is active. Provides search and sort controls identical to what
   * the old Cookbook modal offered in its list pane, so recipes are
   * discoverable without opening a modal.
   *
   * Clicking a recipe calls navigate({ recipe: id }), which switches
   * the main panel to RecipePanel showing that recipe's detail view.
   */
  import { navigate } from '$lib/routing.svelte';
  import { cookbook } from '$lib/cookbook-store.svelte';
  import RecipeRating from './RecipeRating.svelte';

  type SortMode = 'updated' | 'rating';
  let query = $state('');
  // 'updated' keeps the most-recently-edited recipe at the top;
  // 'rating' bubbles the user's favourites up. Matches the old modal.
  let sortMode = $state<SortMode>('updated');

  const visibleRecipes = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const filtered =
      q.length === 0
        ? cookbook.recipes
        : cookbook.recipes.filter((r) => r.title.toLowerCase().includes(q));
    if (sortMode === 'rating') {
      return [...filtered].sort((a, b) => {
        const ar = a.rating ?? -1;
        const br = b.rating ?? -1;
        if (ar !== br) return br - ar;
        return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
      });
    }
    return filtered;
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
    />
    <!-- Sort selector. 'Most recent' is the default to match the
         backing-store order; 'Rating' bubbles favourites up. -->
    <label class="recipe-sort-label" for="rl-sort">
      <span class="visually-hidden">Sort recipes</span>
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
  </div>
  {#if cookbook.loading && cookbook.recipes.length === 0}
    <p class="subtle" style="padding:0.75rem">Loading recipes…</p>
  {:else if visibleRecipes.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {#if cookbook.recipes.length === 0}
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
          onclick={() => navigate({ recipe: r.id })}
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
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
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
