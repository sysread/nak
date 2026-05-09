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
  import { wikiStore, runWikiSearch } from '$lib/wiki-store.svelte';

  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  const SEARCH_DEBOUNCE_MS = 200;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const _q = wikiStore.query;
    void _q;
    if (!app.supabase) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!app.supabase) return;
      void runWikiSearch(app.supabase, app.venice);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  // Sort by title case-insensitively. Semantic-search results come back
  // in similarity order; alphabetising at the view layer keeps the
  // drawer reading as a wiki listing rather than a relevance ranking.
  // Substring-only and empty-query results land here already alpha-
  // sorted but a re-sort is a no-op on those, so this stays the only
  // place that owns the order.
  const sorted = $derived(
    [...wikiStore.results].sort((a, b) =>
      a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
    ),
  );

  function pickArticle(id: string): void {
    navigate({ wiki_article_id: id });
    onSelect?.();
  }
</script>

<div class="recipe-drawer-list">
  <div class="wiki-list-controls">
    <input
      type="search"
      class="sidebar-search-input"
      placeholder="Search wiki"
      aria-label="Search wiki"
      bind:value={wikiStore.query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  {#if wikiStore.loading && wikiStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">Loading wiki…</p>
  {:else if wikiStore.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load wiki: {wikiStore.error}
    </p>
  {:else if sorted.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {#if wikiStore.query.trim().length > 0}
        No matches.
      {:else}
        No wiki articles yet. The background agent writes them as you
        chat, or you can add your own.
      {/if}
    </p>
  {:else}
    {#each sorted as a (a.id)}
      <div class="row thread-row" data-wiki-id-link={a.id}>
        <button
          class="thread grow"
          class:active={route.wiki_article_id === a.id}
          aria-current={route.wiki_article_id === a.id ? 'true' : undefined}
          onclick={() => pickArticle(a.id)}
          title={a.title}
        >
          <span class="wiki-list-title">{a.title}</span>
        </button>
      </div>
    {/each}
  {/if}
</div>

<style>
  /* Mirrors the search-row styling used by the other drawer tabs. The
     bottom border IS the divider between the search row and the
     listing rows. */
  .wiki-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
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
</style>
