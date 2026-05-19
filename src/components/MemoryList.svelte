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
    refreshMemoriesTopicsVocabulary,
  } from '$lib/memories-store.svelte';
  import { formatMemoryConfidenceGlyph } from '$lib/memories';
  import TopicsFilter from './TopicsFilter.svelte';

  // Parent (Chat shell) passes a callback that dismisses the mobile
  // drawer once the panel has navigated to the chosen memory. Optional
  // so the component is still usable in contexts that don't own a
  // drawer.
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

  // Refetch the search whenever the topic selection changes. The
  // store's `runMemoriesSearch` already reads the selection from the
  // store inside its body, so we just trigger another call. Cursors
  // / pagination aren't a thing on the memories surface (there's no
  // bucketing, just a single results list), so no cursor reset is
  // needed - this is the lighter-weight analogue of the threads
  // drawer's filter-change effect.
  $effect(() => {
    // Read for reactive tracking.
    const _sel = memoriesStore.selectedTopics;
    void _sel;
    if (!app.supabase) return;
    void runMemoriesSearch(app.supabase, app.venice);
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
      topics={memoriesStore.topicsVocabulary}
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
          class:active={route.memory === m.id}
          aria-current={route.memory === m.id ? 'true' : undefined}
          onclick={() => pickMemory(m.id)}
          title={m.label}
        >
          <span class="memory-list-label">{m.label}</span>
          {#if formatMemoryConfidenceGlyph(m.confidence)}
            {@const g = formatMemoryConfidenceGlyph(m.confidence)!}
            <!-- Glyph-only badge. The full prose tag rides the title
                 attribute for hover / accessibility; the row's main
                 currency is real estate, and a wordy chip (e.g.
                 "corroborated" eats ~12ch) crowds the label on a
                 narrow drawer. -->
            <span
              class="memory-list-tag"
              title={g.title}
              aria-label={g.title}>{g.glyph}</span>
          {/if}
        </button>
      </div>
    {/each}
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
  /* Two-line memory row: label on top, confidence chip inline. */
  .memory-list-label {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  /* Glyph-only confidence badge. No pill chrome - the emoji is the
     whole signal. Margin-left separates it from the label; the
     font-size matches the row text rather than the smaller prose-
     chip size we used before, since emoji glyphs read better at
     full row size than at 0.7rem. */
  .memory-list-tag {
    margin-left: 0.4rem;
    line-height: 1;
    flex-shrink: 0;
  }
</style>
