<script lang="ts">
  /*
   * Sidebar grocery browse. Shown in the left drawer when the
   * Groceries tab is active. This is the catalog surface over every
   * product variant - on the list and off it alike - with a
   * debounced name search, a status filter (All / On list /
   * Acquired), and a section filter, windowed with an
   * infinite-scroll tail because the catalog grows forever.
   *
   * The working surface (the current shopping list, grouped by
   * section, with the add-input, the inline editor, and section
   * management) is the main panel next door -
   * src/screens/Groceries.svelte. The sidebar's one verb is the
   * checkbox: checked = on the current list. Checking revives the
   * product (opens an entry); unchecking UN-PLANS it - the open
   * entry is deleted, no purchase is recorded. Marking things
   * bought is the panel's job, where the shopper actually is; this
   * surface is for planning the list. A search with no matching
   * product offers an Add action for a brand-new name.
   *
   * Composition-only: every UI-behavior decision lives in
   * src/lib/ui/grocery-list.ts.
   */
  import { app } from '$lib/state.svelte';
  import {
    grocery,
    loadGroceries,
    autoFileProductsTracked,
  } from '$lib/grocery-store.svelte';
  import { onGroceryChange, emitGroceryChange } from '$lib/grocery-events';
  import type { GroceryProductView } from '$lib/supabase';
  import { infiniteScroll } from '$lib/actions/infinite-scroll';
  import {
    BROWSE_SECTION_ALL,
    BROWSE_SECTION_OTHER,
    GROCERY_BROWSE_PAGE_SIZE,
    GROCERY_SEARCH_DEBOUNCE_MS,
    GROCERY_STATUS_FILTER_OPTIONS,
    OTHER_SECTION_LABEL,
    browseOnListArg,
    browseSectionArg,
    canCreateGroceryItem,
    computeBrowseView,
    itemDetailLine,
    splitBrowseRows,
    type GroceryStatusFilter,
  } from '$lib/ui/grocery-list';
  import Scanner from './Scanner.svelte';
  import BucketHeader from './BucketHeader.svelte';
  import { onMount } from 'svelte';

  let query = $state('');
  let statusFilter = $state<GroceryStatusFilter>('all');
  let sectionFilter = $state(BROWSE_SECTION_ALL);
  // Recipe-sourced rows ("Ingredients") are hidden by default - the
  // browse is primarily the staples catalog, and recipe items churn
  // with cooking plans. The toggle widens the window to both groups.
  let showRecipeItems = $state(false);

  let rows = $state<GroceryProductView[]>([]);
  let hasMore = $state(false);
  let loading = $state(false);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);

  // Supersede marker: bump per reload so a slow page-one fetch from a
  // stale query can't clobber a newer one. Cheaper than an
  // AbortController here because PostgREST reads are quick and the
  // stale result is simply dropped.
  let fetchSeq = 0;

  async function loadFirstPage(): Promise<void> {
    if (!app.supabase) return;
    const seq = ++fetchSeq;
    loading = true;
    try {
      const page = await app.supabase.listGroceryProductsPage({
        offset: 0,
        pageSize: GROCERY_BROWSE_PAGE_SIZE,
        query,
        onList: browseOnListArg(statusFilter),
        sectionId: browseSectionArg(sectionFilter),
        manualOnly: !showRecipeItems,
      });
      if (seq !== fetchSeq) return;
      rows = page.rows;
      hasMore = page.hasMore;
      error = null;
    } catch (err) {
      if (seq !== fetchSeq) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === fetchSeq) loading = false;
    }
  }

  async function loadNextPage(): Promise<void> {
    if (!app.supabase || loadingMore || !hasMore) return;
    const seq = fetchSeq;
    loadingMore = true;
    try {
      const page = await app.supabase.listGroceryProductsPage({
        offset: rows.length,
        pageSize: GROCERY_BROWSE_PAGE_SIZE,
        query,
        onList: browseOnListArg(statusFilter),
        sectionId: browseSectionArg(sectionFilter),
        manualOnly: !showRecipeItems,
      });
      if (seq !== fetchSeq) return; // filters changed mid-fetch
      rows = [...rows, ...page.rows];
      hasMore = page.hasMore;
      error = null;
    } catch (err) {
      if (seq === fetchSeq) {
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      loadingMore = false;
    }
  }

  // Reload page one whenever the query or a filter changes (debounced -
  // one timer covers all three since a filter click mid-typing should
  // also supersede the pending search).
  $effect(() => {
    void query;
    void statusFilter;
    void sectionFilter;
    void showRecipeItems;
    if (!app.supabase) return;
    const timer = setTimeout(() => {
      void loadFirstPage();
    }, GROCERY_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // Any grocery write - a panel edit, a Cookbook checkbox, the
  // recipe-edit invalidation trigger, another device - refetches the
  // window so the browse never shows a deleted or re-flagged row.
  $effect(() => {
    return onGroceryChange(() => void loadFirstPage());
  });

  // The section filter reads the store's section list; the panel
  // usually loads it, but the sidebar can mount first (mobile deep
  // link with the drawer open), so kick the shared load here too.
  onMount(() => {
    if (app.supabase && !grocery.loaded && !grocery.loading) {
      void loadGroceries(app.supabase);
    }
  });

  // Checking revives the product; unchecking un-plans it (deletes
  // the open entry, no purchase recorded). This surface is for
  // planning, so its uncheck must never write purchase history -
  // marking things bought happens on the panel's rows.
  function toggleOnList(item: GroceryProductView): void {
    const supabase = app.supabase;
    if (!supabase) return;
    void (async () => {
      try {
        if (item.on_list) await supabase.removeProductFromList(item.id);
        else await supabase.setProductOnList(item.id, true);
        error = null;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        // One nudge refreshes every grocery surface: this browse, the
        // panel's store, and the Cookbook checkboxes.
        emitGroceryChange();
      }
    })();
  }

  /**
   * Create a standalone product from the unmatched search. `auto`
   * fires the section classifier after the insert - same
   * fire-and-forget contract as the panel's add input: the add is
   * instant, and the item hops out of Other when the classification
   * lands.
   */
  function addNewItem(auto: boolean): void {
    const supabase = app.supabase;
    const name = query.trim();
    if (!supabase || name.length === 0) return;
    void (async () => {
      let product;
      try {
        product = await supabase.createGroceryProduct({ name });
        error = null;
        query = '';
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        return;
      } finally {
        emitGroceryChange();
      }
      if (auto) {
        // Fire-and-forget with row feedback: the store tracks the
        // in-flight id so the product's rows spin on both surfaces,
        // and nudges every surface when the filing lands.
        void autoFileProductsTracked(supabase, [product]);
      }
    })();
  }

  const canCreate = $derived(canCreateGroceryItem(query, rows, []));
  const filtered = $derived(
    query.trim().length > 0 ||
      statusFilter !== 'all' ||
      sectionFilter !== BROWSE_SECTION_ALL
  );
  const view = $derived(
    computeBrowseView({ loading, error, count: rows.length, filtered })
  );
</script>

<div class="grocery-browse-list">
  <div class="grocery-browse-controls">
    <input
      type="search"
      name="grocery-browse-search"
      class="sidebar-search-input"
      placeholder="Search items"
      aria-label="Search grocery items"
      bind:value={query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  <div class="grocery-browse-filters">
    <label class="sr-only" for="grocery-status-filter">Status</label>
    <select
      id="grocery-status-filter"
      class="grocery-browse-filter"
      bind:value={statusFilter}
      aria-label="Filter by status"
    >
      {#each GROCERY_STATUS_FILTER_OPTIONS as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
    <label class="sr-only" for="grocery-section-filter">Section</label>
    <select
      id="grocery-section-filter"
      class="grocery-browse-filter"
      bind:value={sectionFilter}
      aria-label="Filter by section"
    >
      <option value={BROWSE_SECTION_ALL}>All sections</option>
      {#each grocery.sections as s (s.id)}
        <option value={s.id}>{s.name}</option>
      {/each}
      <option value={BROWSE_SECTION_OTHER}>{OTHER_SECTION_LABEL}</option>
    </select>
  </div>
  <!-- Recipe-sourced rows are hidden by default (the browse is
       primarily the staples catalog); this widens the window to both
       provenance groups. Server-side filter, so paging stays honest. -->
  <label class="grocery-browse-toggle">
    <input type="checkbox" bind:checked={showRecipeItems} />
    Show recipe ingredients
  </label>

  {#if canCreate}
    <!-- The searched name matches nothing anywhere in the corpus -
         offer to create it directly onto the current list. (Other)
         lands it unfiled; (Auto) additionally runs the section
         classifier in the background. Same pair as the panel's
         add-input create actions. -->
    <button type="button" class="grocery-browse-add" onclick={() => addNewItem(false)}>
      Add "{query.trim()}" (Other)
    </button>
    <button type="button" class="grocery-browse-add" onclick={() => addNewItem(true)}>
      Add "{query.trim()}" (Auto)
    </button>
  {/if}

  {#if view.kind === 'loading'}
    <div class="search-status"><Scanner label="Loading items" size={0.9} /></div>
  {:else if view.kind === 'error'}
    <p class="error grocery-browse-error">{view.message}</p>
  {:else if view.kind === 'empty'}
    <p class="subtle grocery-browse-empty">
      {#if view.reason === 'no-items-yet'}
        No items yet. Add one above, or check ingredients off an
        upcoming or favorite recipe.
      {:else}
        No matches.
      {/if}
    </p>
  {:else}
    <!-- Provenance split: manually-entered "Staples" first, then the
         recipe-sourced "Ingredients" (visible only when the toggle
         above widens the fetch). Grouping is client-side over the
         loaded window - both groups share one paged query. -->
    {#each splitBrowseRows(rows) as group (group.key)}
      <BucketHeader label={group.label} flourish={group.key === 'ingredients'} />
      {#each group.items as item (item.id)}
      <div class="grocery-browse-row" class:on-list={item.on_list}>
        <label class="grocery-check-label">
          <!-- Checked = on the current shopping list. The sidebar's
               single verb: checking revives the product, unchecking
               un-plans it - how a past purchase gets restocked from
               the catalog, and how a stray add gets withdrawn. -->
          <input
            type="checkbox"
            class="grocery-check"
            checked={item.on_list}
            aria-label={item.on_list
              ? `Remove ${item.name} from the list`
              : `Add ${item.name} to the list`}
            onchange={() => toggleOnList(item)}
          />
        </label>
        <button
          type="button"
          class="grocery-browse-body"
          title={item.on_list ? 'Remove from list' : 'Add to list'}
          onclick={() => toggleOnList(item)}
        >
          <!-- Name alone on its line, wrapping. The drawer is the
               narrowest surface the catalog renders on, so anything
               sharing the name's line eats the part the reader came
               for. Quantity / note / recipe title go below it, same
               composition as the panel's rows. -->
          <span class="grocery-browse-name">
            {item.name}
            {#if grocery.classifying.has(item.id)}
              <!-- Auto-sectioning in flight for this product - same
                   ring the panel row shows. -->
              <span
                class="grocery-classifying-ring"
                role="status"
                aria-label="Choosing a section"
                title="Choosing a section"
              ></span>
            {/if}
          </span>
          {#if itemDetailLine(item)}
            <span class="grocery-browse-meta">{itemDetailLine(item)}</span>
          {/if}
        </button>
        {#if item.image_url}
          <img class="grocery-browse-thumb" src={item.image_url} alt={item.name} loading="lazy" />
        {/if}
      </div>
      {/each}
    {/each}
    {#if hasMore}
      <!-- Infinite-scroll sentinel, same shape as the recipe sidebar:
           fires loadNextPage as it nears the viewport; the loadingMore
           guard makes a fast scroll safe. -->
      <div
        class="grocery-browse-sentinel"
        use:infiniteScroll={{ onHit: () => void loadNextPage() }}
        aria-hidden="true"
      >
        {#if loadingMore}
          <Scanner label="Loading more items" size={0.85} />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* Scroll container - twin of the global .recipe-drawer-list rule so
     the tab switch keeps the same layout behavior. */
  .grocery-browse-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .grocery-browse-controls {
    display: flex;
    padding: 0.4rem 0.6rem 0;
  }
  .grocery-browse-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  /* Filter row under the search input, aligned to the same gutters.
     Two selects share the width; each shrinks so a long section name
     truncates instead of widening the drawer. */
  .grocery-browse-filters {
    display: flex;
    gap: 0.35rem;
    padding: 0.35rem 0.6rem 0.5rem;
  }
  .grocery-browse-filter {
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.8rem;
  }
  /* Provenance toggle under the filter row, same gutters. The input
     gets explicit box sizing and zero margin: global form-control
     styling stretches inputs in this tree, which floated the
     checkbox away from its label and let the text wrap under it. */
  .grocery-browse-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.6rem 0.5rem;
    font-size: 0.8rem;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .grocery-browse-toggle input {
    width: 0.95rem;
    height: 0.95rem;
    margin: 0;
    flex: 0 0 auto;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .grocery-browse-add {
    margin: 0 0.6rem 0.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--accent);
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }
  .grocery-browse-error {
    padding: 0 0.75rem 0.5rem;
  }
  .grocery-browse-empty {
    padding: 0.75rem;
  }

  .grocery-browse-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.75rem;
  }
  /* Rows NOT on the current list read muted so the checked-on subset
     pops while scanning the history. */
  .grocery-browse-row:not(.on-list) {
    opacity: 0.65;
  }
  .grocery-check-label {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .grocery-check {
    width: 1.15rem;
    height: 1.15rem;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .grocery-browse-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.1rem;
    border: none;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    padding: 0;
    cursor: pointer;
  }
  /* Wraps rather than ellipsizes - the item name is the whole point
     of a browse row, and the drawer is narrow enough that clipping
     starts on ordinary names. `overflow-wrap: anywhere` handles names
     with no space to break at, which would otherwise widen the row
     past the drawer. */
  .grocery-browse-name {
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
  /* Quantity, note, and recipe title on their own block under the
     name, wrapping for the same reason. */
  .grocery-browse-meta {
    font-size: 0.72rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  /* Auto-sectioning feedback beside the name - same ring as the
     panel rows and the recipe checkboxes' busy state. */
  .grocery-classifying-ring {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    margin-left: 0.3rem;
    vertical-align: -0.05rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: grocery-classify-spin 700ms linear infinite;
  }
  @keyframes grocery-classify-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .grocery-browse-thumb {
    flex-shrink: 0;
    width: 1.8rem;
    height: 1.8rem;
    object-fit: cover;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }
  .grocery-browse-sentinel {
    min-height: 1px;
    padding: 0.5rem 0;
  }
</style>
