<script lang="ts">
  /*
   * Sidebar for the Samskara diagnostics tab's Corpus panel. Owns the
   * search input, the tier filter, the sort control, and the
   * "hide similar" slider - all bound to `samskaraBrowseStore` so the
   * main panel's detail view reflows in lock-step. Clicking a row sets
   * `route.samskara_id` so the panel shows that samskara's detail.
   *
   * Read-only: no edit/delete. This is an observability surface (see
   * docs/dev/samskara.md's observability section), not a curation tool.
   *
   * All decision logic - the sort/tier option lists, the hide-similar
   * collapse, label/valence formatting - lives in
   * `$lib/ui/samskara-browse`; this file is Svelte glue only.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    samskaraBrowseStore,
    refreshSamskaraView,
    loadMoreSamskaras,
  } from '$lib/samskara-browse-store.svelte';
  import {
    SEARCH_DEBOUNCE_MS,
    TIER_FILTERS,
    SORT_OPTIONS,
    emptyMessage,
    tierBadge,
    collapseSimilar,
    matchSummary,
    type CollapsedRow,
  } from '$lib/ui/samskara-browse';
  import { infiniteScroll } from '$lib/actions/infinite-scroll';
  import Scanner from './Scanner.svelte';
  import type { SamskaraBrowseSort } from '$lib/supabase';

  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Debounced re-search on query changes.
  $effect(() => {
    const _q = samskaraBrowseStore.query;
    void _q;
    if (!app.supabase) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (app.supabase) void refreshSamskaraView(app.supabase);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  // Immediate re-load when the structural controls change (tier, sort,
  // hide-similar toggle, threshold). These aren't typed character by
  // character, so no debounce.
  $effect(() => {
    const _t = samskaraBrowseStore.tier;
    const _s = samskaraBrowseStore.sort;
    const _h = samskaraBrowseStore.hideSimilar;
    const _th = samskaraBrowseStore.hideSimilarThreshold;
    void [_t, _s, _h, _th];
    if (!app.supabase) return;
    void refreshSamskaraView(app.supabase);
  });

  // Displayed rows: collapse near-duplicates under representatives when
  // the slider is on, otherwise pass every row through untouched.
  const displayRows = $derived<CollapsedRow[]>(
    samskaraBrowseStore.hideSimilar
      ? collapseSimilar(samskaraBrowseStore.results, samskaraBrowseStore.clusterMap)
      : samskaraBrowseStore.results.map((row) => ({ row, similarCount: 0 }))
  );

  function pick(id: string): void {
    navigate({ samskara_id: id });
    onSelect?.();
  }

  function setTier(value: number | null): void {
    samskaraBrowseStore.tier = value;
  }
</script>

<div class="recipe-drawer-list">
  <div class="samskara-list-controls">
    <input
      type="search"
      name="samskara-search"
      class="sidebar-search-input"
      placeholder="Search samskaras"
      aria-label="Search samskaras"
      bind:value={samskaraBrowseStore.query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>

  <div class="samskara-list-filters">
    <div class="samskara-tier-seg" role="group" aria-label="Tier filter">
      {#each TIER_FILTERS as opt (opt.label)}
        <button
          type="button"
          class="samskara-seg-btn"
          class:active={samskaraBrowseStore.tier === opt.value}
          aria-pressed={samskaraBrowseStore.tier === opt.value}
          onclick={() => setTier(opt.value)}
        >{opt.label}</button>
      {/each}
    </div>
    <select
      class="samskara-sort-select"
      aria-label="Sort samskaras"
      bind:value={samskaraBrowseStore.sort as SamskaraBrowseSort}
    >
      {#each SORT_OPTIONS as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </div>

  <div class="samskara-hide-similar">
    <label class="samskara-hide-similar-toggle">
      <input type="checkbox" bind:checked={samskaraBrowseStore.hideSimilar} />
      <span>Hide similar</span>
    </label>
    {#if samskaraBrowseStore.hideSimilar}
      <div class="samskara-threshold-row">
        <input
          type="range"
          min="0.5"
          max="0.95"
          step="0.01"
          bind:value={samskaraBrowseStore.hideSimilarThreshold}
          aria-label="Similarity threshold"
          title="Higher hides only near-duplicates; lower folds loosely-related claims together"
        />
        <span class="samskara-threshold-readout">{samskaraBrowseStore.hideSimilarThreshold.toFixed(2)}</span>
      </div>
      <p class="samskara-match-count">
        {matchSummary(displayRows.length, samskaraBrowseStore.results.length)}
      </p>
    {/if}
  </div>

  {#if samskaraBrowseStore.loading && samskaraBrowseStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">Loading samskaras…</p>
  {:else if samskaraBrowseStore.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load samskaras: {samskaraBrowseStore.error}
    </p>
  {:else if displayRows.length === 0}
    <p class="subtle" style="padding:0.75rem">{emptyMessage(samskaraBrowseStore.query)}</p>
  {:else}
    {#each displayRows as item (item.row.id)}
      <div class="row thread-row">
        <button
          class="thread grow samskara-row-btn"
          class:active={route.samskara_id === item.row.id}
          aria-current={route.samskara_id === item.row.id ? 'true' : undefined}
          onclick={() => pick(item.row.id)}
          title={item.row.prediction}
        >
          <span class="samskara-row-badge" class:t2={item.row.tier === 2}>{tierBadge(item.row.tier)}</span>
          <span class="samskara-row-pred">{item.row.prediction}</span>
          {#if item.similarCount > 0}
            <span class="samskara-row-similar" title="{item.similarCount} similar folded here">+{item.similarCount}</span>
          {/if}
        </button>
      </div>
    {/each}
    {#if samskaraBrowseStore.hasMore}
      <div
        class="samskara-list-sentinel"
        use:infiniteScroll={{ onHit: () => app.supabase && loadMoreSamskaras(app.supabase) }}
        aria-hidden="true"
      >
        {#if samskaraBrowseStore.loadingMore}
          <Scanner label="Loading more samskaras" size={0.85} />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .samskara-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.4rem;
  }
  .samskara-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  .samskara-list-filters {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin: 0 0.6rem 0.4rem;
  }
  /* Tier segmented control - three small buttons sharing one border. */
  .samskara-tier-seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .samskara-seg-btn {
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    background: var(--surface);
    color: var(--muted);
    border: none;
    border-right: 1px solid var(--border);
    cursor: pointer;
  }
  .samskara-seg-btn:last-child {
    border-right: none;
  }
  .samskara-seg-btn.active {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--text);
  }
  .samskara-sort-select {
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    padding: 0.2rem 0.3rem;
  }
  /* Stack the toggle and the threshold slider on separate lines - the
     sidebar is too narrow to fit the checkbox, label, slider, and value
     on one row without the slider getting crushed. */
  .samskara-hide-similar {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0 0.6rem 0.5rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .samskara-hide-similar-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  /* The global `input { width: 100% }` rule stretches a bare checkbox to
     fill the flex row - which floats the box into the middle and shoves
     the label to the edge (see the .toggle-row override in styles.css).
     Pin it to its intrinsic size so checkbox + label read as one
     left-aligned unit. */
  .samskara-hide-similar-toggle input[type='checkbox'] {
    width: auto;
    flex-shrink: 0;
    margin: 0;
  }
  .samskara-match-count {
    margin: 0.1rem 0 0;
    font-size: 0.72rem;
    color: var(--muted);
  }
  /* Slider gets its own full-width line; the value label sits at the end
     and doesn't shrink, so the track takes whatever's left. */
  .samskara-threshold-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .samskara-threshold-row input[type='range'] {
    flex: 1;
    min-width: 0;
  }
  .samskara-threshold-readout {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .samskara-row-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }
  /* Tier badge - tier 1 muted, tier 2 accented so compounds stand out. */
  .samskara-row-badge {
    flex-shrink: 0;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.05rem 0.3rem;
    border-radius: 999px;
    background: var(--bg-2);
    color: var(--muted);
  }
  .samskara-row-badge.t2 {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    color: var(--text);
  }
  .samskara-row-pred {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .samskara-row-similar {
    flex-shrink: 0;
    font-size: 0.7rem;
    color: var(--muted);
  }
  .samskara-list-sentinel {
    min-height: 1px;
    padding: 0.5rem 0;
  }
</style>
