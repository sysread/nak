<script lang="ts">
  /*
   * Sidebar memory listing. Shown in the left drawer when the Memories
   * tab is active. Owns the search input - bound to `memoriesStore.query`
   * so the panel-side list filters in lock-step. Rows show the label
   * plus a small confidence badge so the user can scan the list at a
   * glance without opening anything.
   *
   * Click on a row sets `route.memory` so the main panel shows that
   * one memory's full card (label + data + relations + edit / delete /
   * reaffirm controls). The sidebar's job is "browse + select"; the
   * panel's job is "show the picked one in detail".
   *
   * Search is the same debounced semantic-search pipeline the assistant
   * uses for `memory_search` - see `searchMemoriesSemantic` in
   * `$lib/memories`. Drives `runMemoriesSearch` on the store.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    memoriesStore,
    runMemoriesSearch,
    loadMoreMemories,
    refreshMemoriesTopicsVocabulary,
  } from '$lib/memories-store.svelte';
  import { classifyMemoryConfidence } from '$lib/memories';
  import { SEARCH_DEBOUNCE_MS, emptyMessage } from '$lib/ui/memories-list';
  import { infiniteScroll } from '$lib/actions/infinite-scroll';
  import Scanner from './Scanner.svelte';
  import TopicsFilter from './TopicsFilter.svelte';

  // Parent (Chat shell) passes a callback that dismisses the mobile
  // drawer once the panel has navigated to the chosen memory. Optional
  // so the component is still usable in contexts that don't own a
  // drawer.
  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

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
      void runMemoriesSearch(app.supabase);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  function pickMemory(id: string): void {
    navigate({ memory: id });
    onSelect?.();
  }

  // Pull the topic vocabulary on mount so the [Topics ▾] dropdown
  // has options to show as soon as the drawer opens. Subsequent
  // refreshes happen from realtime memory-update events (wired up
  // in Chat.svelte's onUpdate path) - we don't poll. Best-effort:
  // the helper swallows errors and leaves any prior vocabulary
  // intact, so the dropdown stays usable across a transient
  // Supabase blip.
  onMount(() => {
    if (!app.supabase) return;
    void refreshMemoriesTopicsVocabulary(app.supabase);
  });

  // Refetch whenever the topic selection changes. `runMemoriesSearch`
  // reads the selection from the store inside its body and dispatches
  // on the query - empty re-pages the browse list from the top
  // (resetting the offset window), non-empty re-runs the capped
  // search - so we just trigger another call.
  $effect(() => {
    // Read for reactive tracking.
    const _sel = memoriesStore.selectedTopics;
    void _sel;
    if (!app.supabase) return;
    void runMemoriesSearch(app.supabase);
  });

  function setTopics(next: string[]): void {
    memoriesStore.selectedTopics = next;
  }
</script>

<div class="recipe-drawer-list">
  <div class="memory-list-controls">
    <input
      type="search"
      name="memory-search"
      class="sidebar-search-input"
      placeholder="Search memories"
      aria-label="Search memories"
      bind:value={memoriesStore.query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  <div class="memory-list-topics">
    <TopicsFilter
      vocabulary={memoriesStore.topicsVocabulary}
      selected={memoriesStore.selectedTopics}
      onChange={setTopics}
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
      {emptyMessage(memoriesStore.query)}
    </p>
  {:else}
    {#each memoriesStore.results as m (m.id)}
      {@const tag = classifyMemoryConfidence(m.confidence)}
      <div class="row thread-row" data-memory-id-link={m.id}>
        <button
          class="thread grow"
          class:active={route.memory === m.id}
          class:mem-corroborated={tag === 'corroborated'}
          class:mem-hedged={tag === 'hedged'}
          class:mem-shaky={tag === 'shaky'}
          aria-current={route.memory === m.id ? 'true' : undefined}
          onclick={() => pickMemory(m.id)}
          title={tag ? `${m.label} (${tag})` : m.label}
        >
          <span class="memory-list-label">{m.label}</span>
        </button>
      </div>
    {/each}
    {#if memoriesStore.hasMore}
      <!-- Infinite-scroll sentinel for the browse list. hasMore is
           forced false during a search (capped, unpaged), so this only
           appears in the empty-query regime. -->
      <div
        class="memory-list-sentinel"
        use:infiniteScroll={{ onHit: () => app.supabase && loadMoreMemories(app.supabase) }}
        aria-hidden="true"
      >
        {#if memoriesStore.loadingMore}
          <Scanner label="Loading more memories" size={0.85} />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* Mirrors `.recipe-list-controls` so the search bar reads as the
     same visual element across the four drawer tabs. The bottom margin
     is the only separator between the search row and the listing rows
     below - no rule line. */
  .memory-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    /* Space below the search row so the first memory row doesn't crowd
       the search input. Mirrors the chats / recipes / wiki tabs. */
    margin-bottom: 0.5rem;
  }
  .memory-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  /* Topic-filter row. Sits between the search input and the memory
     listing. The controls row's padding-x is 0.6rem so this row's
     margin-x matches: the Topics trigger's left and right edges line
     up with the search input's edges above. Mirrors
     `.recipe-list-topics`. Negative margin-top tucks the trigger
     close under the search row; bottom margin separates from the
     first listing entry. */
  .memory-list-topics {
    margin: -0.3rem 0.6rem 0.5rem;
    flex-shrink: 0;
  }
  /* Single-line memory row: label only. Confidence rides as a
     background tint on the row itself rather than as a trailing
     badge - long titles used to push the glyph off-screen, and the
     point of the listing is to scan labels at a glance, so the
     signal moves onto the row chrome. */
  .memory-list-label {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  /* Pagination sentinel - a small box at the list tail the
     IntersectionObserver can catch as it nears the viewport. */
  .memory-list-sentinel {
    min-height: 1px;
    padding: 0.5rem 0;
  }
  /* Confidence-tinted rows. Green for the affirmed band, red shades
     for the doubted bands (hedged = light, shaky = stronger). The
     tints use `color-mix` against `--ok` / `--danger` so they pick
     up theme + accent variation without per-theme overrides. Hover
     and active states layer on top via separate background-color
     transitions in the global `.thread` rules; we ride only the
     default state here so the active-selection accent-weak fill
     still reads clearly when a tinted row is the picked one. */
  .thread.mem-corroborated:not(.active) {
    background: color-mix(in srgb, var(--ok) 16%, transparent);
  }
  .thread.mem-corroborated:not(.active):hover {
    background: color-mix(in srgb, var(--ok) 24%, transparent);
  }
  .thread.mem-hedged:not(.active) {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }
  .thread.mem-hedged:not(.active):hover {
    background: color-mix(in srgb, var(--danger) 20%, transparent);
  }
  .thread.mem-shaky:not(.active) {
    background: color-mix(in srgb, var(--danger) 24%, transparent);
  }
  .thread.mem-shaky:not(.active):hover {
    background: color-mix(in srgb, var(--danger) 32%, transparent);
  }
</style>
