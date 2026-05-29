<script lang="ts">
  /*
   * Sidebar listing for the user's document Library. Shown in the left
   * drawer when the Library tab is active. Owns the search input - bound to
   * `documentStore.query` so a search keystroke filters the listing in place.
   *
   * Browse order is newest-first (the Library is curated reference material,
   * read most-recent-first, not browsed alphabetically). Search is a debounced
   * substring match over the user's documents (`SupabaseService.searchDocuments`).
   * Clicking a row sets `route.document_id` so the main panel renders that
   * document.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    documentStore,
    runDocumentSearch,
    loadMoreDocuments,
  } from '$lib/documents-store.svelte';
  import {
    SEARCH_DEBOUNCE_MS,
    emptyMessage,
    scannerLabel,
    statusLabel,
  } from '$lib/ui/library-list';
  import { infiniteScroll } from '$lib/actions/infinite-scroll';
  import Scanner from './Scanner.svelte';

  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const _q = documentStore.query;
    void _q;
    if (!app.supabase) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!app.supabase) return;
      void runDocumentSearch(app.supabase);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  function pickDocument(id: string): void {
    navigate({ document_id: id });
    onSelect?.();
  }
</script>

<div class="recipe-drawer-list">
  <div class="library-list-controls">
    <input
      type="search"
      name="library-search"
      class="sidebar-search-input"
      placeholder="Search documents"
      aria-label="Search documents"
      bind:value={documentStore.query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  {#if documentStore.loading}
    <div class="search-status">
      <Scanner label={scannerLabel(documentStore.query)} size={0.9} />
    </div>
  {:else if documentStore.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load documents: {documentStore.error}
    </p>
  {:else if documentStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {emptyMessage(documentStore.query)}
    </p>
  {:else}
    {#each documentStore.results as d (d.id)}
      <div class="row thread-row" data-document-id-link={d.id}>
        <button
          class="thread grow library-row"
          class:active={route.document_id === d.id}
          aria-current={route.document_id === d.id ? 'true' : undefined}
          onclick={() => pickDocument(d.id)}
          title={d.title}
        >
          <span class="library-row-title">{d.title}</span>
          <span class="library-row-meta">
            <span class="library-row-filename">{d.filename}</span>
            {#if statusLabel(d.extraction_status)}
              <span
                class="library-status"
                class:failed={d.extraction_status === 'failed'}
              >{statusLabel(d.extraction_status)}</span>
            {/if}
          </span>
        </button>
      </div>
    {/each}
    {#if documentStore.hasMore}
      <div
        class="library-list-sentinel"
        use:infiniteScroll={{ onHit: () => app.supabase && loadMoreDocuments(app.supabase) }}
        aria-hidden="true"
      >
        {#if documentStore.loadingMore}
          <Scanner label="Loading more documents" size={0.85} />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .library-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.5rem;
  }
  .library-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  .library-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
  }
  .library-row-title {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .library-row-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    max-width: 100%;
  }
  .library-row-filename {
    font-size: 0.78rem;
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .library-status {
    font-size: 0.7rem;
    opacity: 0.7;
    flex-shrink: 0;
  }
  .library-status.failed {
    color: var(--error, #c0392b);
    opacity: 0.9;
  }
  .library-list-sentinel {
    min-height: 1px;
    padding: 0.5rem 0;
  }
</style>
