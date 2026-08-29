<script lang="ts">
  /*
   * Sidebar listing for the user's wiki. Shown in the left drawer when
   * the Wiki tab is active. Owns the search input - bound to
   * `wikiStore.query` so a search keystroke filters the listing in
   * place.
   *
   * Articles are displayed alphabetically by title (case-insensitive)
   * regardless of recency - the wiki is meant to be browsed by topic,
   * not by edit time. Click on a row sets `route.wiki_article_id` so
   * the main panel renders that article's full body.
   *
   * Search is the same debounced semantic-search pipeline the assistant
   * uses for `wiki_search` - see `searchWikiArticlesSemantic` in
   * `$lib/wiki`. Drives `runWikiSearch` on the store.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import { wikiStore, runWikiSearch, loadMoreWiki } from '$lib/wiki-store.svelte';
  import { SEARCH_DEBOUNCE_MS, emptyMessage, scannerLabel } from '$lib/ui/wiki-list';
  import { infiniteScroll } from '$lib/actions/infinite-scroll';
  import Scanner from './Scanner.svelte';

  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const _q = wikiStore.query;
    void _q;
    if (!app.supabase) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!app.supabase) return;
      void runWikiSearch(app.supabase);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  function pickArticle(id: string): void {
    navigate({ wiki_article_id: id });
    onSelect?.();
  }

  // Reconnect refresh: when the device comes back online while the Wiki
  // tab is open, re-run the query so the offline-cache regime
  // (Favorites-only, search hidden) gives way to the full browse list +
  // search. runWikiSearch routes to loadWikiFirstPage when the query is
  // empty (which it is offline, since the search box is hidden), and
  // loadWikiFirstPage clears wikiStore.fromCache on a successful fetch.
  $effect(() => {
    const onOnline = (): void => {
      if (app.supabase) void runWikiSearch(app.supabase);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  });

  // The Favorites bucket only makes sense over the browse regime - a
  // search shows a flat relevance list, not sectioned browse. Same
  // gate the cookbook sidebar uses for its Upcoming / Favorites
  // buckets.
  const showFavorites = $derived(
    wikiStore.query.trim().length === 0 && wikiStore.favorites.length > 0,
  );
</script>

{#snippet articleRow(id: string, title: string)}
  <div class="row thread-row" data-wiki-id-link={id}>
    <button
      class="thread grow"
      class:active={route.wiki_article_id === id}
      aria-current={route.wiki_article_id === id ? 'true' : undefined}
      onclick={() => pickArticle(id)}
      title={title}
    >
      <span class="wiki-list-title">{title}</span>
    </button>
  </div>
{/snippet}

<div class="recipe-drawer-list">
  <!-- Search needs the server (semantic embed round-trip), so the
       search box is hidden in the offline-cache regime - the listing
       below is just the saved Favorites bucket. -->
  {#if !wikiStore.fromCache}
  <div class="wiki-list-controls">
    <input
      type="search"
      name="wiki-search"
      class="sidebar-search-input"
      placeholder="Search wiki"
      aria-label="Search wiki"
      bind:value={wikiStore.query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  {/if}
  {#if wikiStore.loading && wikiStore.favorites.length === 0 && wikiStore.results.length === 0}
    <!-- Replace the entries list with the K.I.T.T. scanner for the
         duration of any in-flight wiki search - including the empty-
         query refresh on mount. Embedding the query takes a Venice
         round-trip; without this the drawer reads as frozen. Suppressed
         once cache-first paint has filled the Favorites bucket, so an
         offline open shows the saved set instead of a spinner that
         blocks on a fetch that may never fail fast. -->
    <div class="search-status">
      <Scanner label={scannerLabel(wikiStore.query)} size={0.9} />
    </div>
  {:else if wikiStore.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load wiki: {wikiStore.error}
    </p>
  {:else if wikiStore.favorites.length === 0 && wikiStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {emptyMessage(wikiStore.query)}
    </p>
  {:else}
    {#if showFavorites}
      <!-- Locked bucket: the complete locked set (title ASC),
           fetched whole by loadWikiFirstPage. Locking an article
           saves it offline AND protects it from agent edits, so this
           section doubles as "available on this device with no
           network" - and offline it is the ONLY section (the browse
           list below needs the server). Locked articles also keep
           their natural alphabetical spot in the full list below
           when online - the duplication is intentional, mirroring
           the cookbook sidebar. -->
      <div class="wiki-list-section-label" aria-hidden="true">
        Locked &middot; saved offline
      </div>
      {#each wikiStore.favorites as a (a.id)}
        {@render articleRow(a.id, a.title)}
      {/each}
      {#if wikiStore.results.length > 0}
        <div class="wiki-list-section-label" aria-hidden="true">All articles</div>
      {/if}
    {/if}
    <!-- Rendered in server order (title ASC for browse, relevance for
         search). No client re-sort: a localeCompare pass over a partial
         page would disagree with the server's page boundaries and
         shuffle rows across the pagination seam mid-scroll. -->
    {#each wikiStore.results as a (a.id)}
      {@render articleRow(a.id, a.title)}
    {/each}
    {#if wikiStore.hasMore}
      <!-- Infinite-scroll sentinel for the browse list. hasMore is
           forced false during a search (capped, unpaged). -->
      <div
        class="wiki-list-sentinel"
        use:infiniteScroll={{ onHit: () => app.supabase && loadMoreWiki(app.supabase) }}
        aria-hidden="true"
      >
        {#if wikiStore.loadingMore}
          <Scanner label="Loading more articles" size={0.85} />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* Mirrors the search-row styling used by the other drawer tabs. The
     bottom margin is the only separator between the search row and the
     listing rows - no rule line. */
  .wiki-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.5rem;
  }
  .wiki-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  .wiki-list-title {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  /* Section divider between the Favorites bucket and the full list.
     Mirrors the cookbook sidebar's bucket labels - quiet, uppercase,
     not a clickable row. */
  .wiki-list-section-label {
    padding: 0.5rem 0.7rem 0.2rem;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-subtle, var(--text));
    opacity: 0.7;
  }
  /* Pagination sentinel - a small box at the list tail the
     IntersectionObserver can catch as it nears the viewport. */
  .wiki-list-sentinel {
    min-height: 1px;
    padding: 0.5rem 0;
  }
</style>
