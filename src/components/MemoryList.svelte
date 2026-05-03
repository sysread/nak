<script lang="ts">
  /*
   * Sidebar memory listing. Shown in the left drawer when the Memories
   * tab is active. Owns the search input - bound to `memoriesStore.query`
   * so the panel-side list filters in lock-step. Rows show the label
   * plus a small confidence badge so the user can scan the list at a
   * glance without opening anything.
   *
   * Click on a row scrolls the corresponding card on the main panel
   * into view via `data-memory-id="<id>"`. Editing happens on the panel
   * (memories don't have a heavyweight detail surface like recipes do),
   * so the sidebar's job is just "browse + jump-to".
   *
   * Search is the same debounced semantic-search pipeline the assistant
   * uses for `memory_search` - see `searchMemoriesSemantic` in
   * `$lib/memories`. Drives `runMemoriesSearch` on the store.
   */
  import { app } from '$lib/state.svelte';
  import {
    memoriesStore,
    runMemoriesSearch,
  } from '$lib/memories-store.svelte';
  import { classifyMemoryConfidence } from '$lib/memories';

  // Parent (Chat shell) passes a callback that dismisses the mobile
  // drawer once the panel scrolls to the chosen memory. Optional so
  // the component is still usable in contexts that don't own a drawer.
  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  // Same window the old in-modal search used. Long enough that the
  // semantic-search request fires once at the end of a typing burst,
  // short enough that intent-to-result still feels responsive.
  const SEARCH_DEBOUNCE_MS = 200;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Re-run the semantic search whenever the bound query changes. Reads
  // `memoriesStore.query` reactively so a keystroke in EITHER the
  // sidebar input or (hypothetically) any other binding feeds the same
  // search.
  $effect(() => {
    // Read the dependencies up front so the effect re-runs on changes.
    const _q = memoriesStore.query;
    void _q;
    if (!app.supabase) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!app.supabase) return;
      void runMemoriesSearch(app.supabase, app.venice);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  function jumpTo(id: string): void {
    onSelect?.();
    // Defer one frame so the panel has rendered the row even if the
    // mobile drawer transition is just starting.
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-memory-id="${CSS.escape(id)}"]`,
      ) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      // Brief flash so the click target is unambiguous after the jump.
      // The class is removed by the panel's animationend handler (see
      // .memory-card.flash in Memories.svelte).
      el.classList.remove('flash');
      // Force a reflow so re-adding the class restarts the animation
      // even if the user clicks the same row twice in a row.
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }
</script>

<div class="recipe-drawer-list">
  <div class="memory-list-controls">
    <input
      type="search"
      class="sidebar-search-input"
      placeholder="Search memories"
      aria-label="Search memories"
      bind:value={memoriesStore.query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  {#if memoriesStore.loading && memoriesStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">Loading memories…</p>
  {:else if memoriesStore.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load memories: {memoriesStore.error}
    </p>
  {:else if memoriesStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {#if memoriesStore.query.trim().length > 0}
        No matches.
      {:else}
        No memories yet. They accumulate as you chat.
      {/if}
    </p>
  {:else}
    {#each memoriesStore.results as m (m.id)}
      <div class="row thread-row" data-memory-id-link={m.id}>
        <button
          class="thread grow"
          onclick={() => jumpTo(m.id)}
          title={m.label}
        >
          <span class="memory-list-label">{m.label}</span>
          {#if classifyMemoryConfidence(m.confidence)}
            <span
              class="memory-list-tag tag-{classifyMemoryConfidence(m.confidence)}"
            >{classifyMemoryConfidence(m.confidence)}</span>
          {/if}
        </button>
      </div>
    {/each}
  {/if}
</div>

<style>
  /* Mirrors `.recipe-list-controls` so the search bar reads as the
     same visual element across the four drawer tabs. The bottom border
     IS the divider between the search row and the listing rows below. */
  .memory-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .memory-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  /* Two-line memory row: label on top, confidence chip inline. */
  .memory-list-label {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .memory-list-tag {
    font-size: 0.7rem;
    padding: 0.05rem 0.35rem;
    margin-left: 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    line-height: 1;
    text-transform: lowercase;
    font-weight: 500;
  }
  /* Match the panel-side palette so the chip means the same thing in
     both places. Keep restrained - this is a row-level chip on a
     dense list, not a headline element. */
  :global(.memory-list-tag.tag-corroborated) {
    background: var(--accent-bg, var(--bg-2));
    border-color: var(--accent, var(--border));
    color: var(--accent, var(--text));
  }
  :global(.memory-list-tag.tag-hedged) {
    background: var(--bg-2);
    color: var(--muted);
  }
  :global(.memory-list-tag.tag-shaky) {
    background: var(--bg-2);
    color: var(--muted);
    border-style: dashed;
  }
</style>
