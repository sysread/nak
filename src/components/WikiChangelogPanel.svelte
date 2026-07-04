<script lang="ts">
  /*
   * Inline wiki changelog. Sibling of WikiList - lives inside the
   * Wiki tab's main panel as the default view when no article is
   * selected. Renders the user's wiki_changelog table (one row per
   * individual create/update/delete), newest first, with "Load more"
   * pagination keyed by created_at.
   *
   * Mounted from Wiki.svelte's empty-state branch (no
   * route.wiki_article_id, not composing). Clicking an entry whose
   * underlying article still exists selects it via wiki_article_id;
   * entries whose article has been deleted render the title snapshot
   * as plain text (kind chip carries the "Deleted" signal).
   *
   * Was a modal (src/screens/WikiChangelog.svelte) reachable from a
   * top-bar clock button. Moved inline so the wiki tab has a useful
   * default surface instead of a "pick an article from the sidebar"
   * placeholder.
   *
   * Holds an in-memory page list; nothing here is persisted across
   * panel teardown, so reopening (e.g. switching tabs and back)
   * always fetches the first page fresh.
   */
  import { app } from '$lib/state.svelte';
  import { navigate } from '$lib/routing.svelte';
  import { onWikiChange, onWikiRecordChange } from '$lib/wiki-events';
  import type { WikiChangelogEntry } from '$lib/supabase';
  import {
    PAGE_SIZE,
    canOpenArticle,
    formatChangelogStamp,
    isExhausted,
    kindLabel,
  } from '$lib/ui/wiki-changelog-panel';

  interface Props {
    /**
     * Optional "+ New article" affordance. When supplied, the panel
     * header renders a button that invokes this callback - Wiki.svelte
     * uses it to flip into compose mode. Omitted callers get a
     * heading-only header.
     */
    onAddArticle?: () => void;
  }
  let { onAddArticle }: Props = $props();

  let entries = $state<WikiChangelogEntry[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  // True when the last fetched page came back smaller than PAGE_SIZE -
  // i.e. we've reached the tail and the "Load more" button has nothing
  // to ask for.
  let exhausted = $state(false);

  /**
   * Fetch the first page. Used on mount and on a cross-surface wiki
   * change (the autonomous agent landing a new row while the panel is
   * visible). Resets `exhausted` because a fresh write at the head
   * means there's at least one new row even if the tail hadn't
   * changed.
   */
  async function loadFirstPage(): Promise<void> {
    if (!app.supabase) return;
    loading = true;
    error = null;
    try {
      const rows = await app.supabase.listWikiChangelog({ limit: PAGE_SIZE });
      entries = rows;
      exhausted = isExhausted(rows.length);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!app.supabase || loadingMore || exhausted) return;
    const tail = entries[entries.length - 1];
    if (!tail) return;
    loadingMore = true;
    error = null;
    try {
      const rows = await app.supabase.listWikiChangelog({
        limit: PAGE_SIZE,
        before: tail.created_at,
      });
      entries = [...entries, ...rows];
      if (isExhausted(rows.length)) exhausted = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    void loadFirstPage();
    // Keep the panel in sync with cross-surface writes while it's
    // mounted. The wiki-change event fires from the tool path, the
    // librarian, and the in-panel direct edits; the record-change event
    // fires from record writes (compose form, chat tools, extraction
    // agent, librarian migration) - any of them could have appended a
    // changelog row, since records now log to the same changelog.
    const offArticle = onWikiChange(() => {
      void loadFirstPage();
    });
    const offRecord = onWikiRecordChange(() => {
      void loadFirstPage();
    });
    return () => {
      offArticle();
      offRecord();
    };
  });

  function openArticle(articleId: string): void {
    // Already on the Wiki tab (this panel only mounts there) - just
    // select the article. No drawer flip needed, no modal to close.
    navigate({ wiki_article_id: articleId });
  }
</script>

<section class="wiki-changelog-panel" aria-label="Wiki changelog">
  <header class="wiki-changelog-header">
    <h2 class="wiki-changelog-title">Wiki changelog</h2>
    {#if onAddArticle}
      <button
        type="button"
        class="primary"
        onclick={onAddArticle}
      >+ New article</button>
    {/if}
  </header>

  {#if loading}
    <p class="subtle">Loading...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if entries.length === 0}
    <p class="subtle">
      No wiki changes yet. Anything added, edited, or deleted from
      the wiki - by you, by the agent, or by the librarian - lands
      here with a one-line commit message.
    </p>
  {:else}
    <ul class="wiki-changelog-list">
      {#each entries as entry (entry.id)}
        <li class="wiki-changelog-row">
          <div class="wiki-changelog-row-head">
            <span
              class="wiki-changelog-kind kind-{entry.kind}"
              aria-label={kindLabel(entry.kind)}
              title={kindLabel(entry.kind)}
            >{kindLabel(entry.kind)}</span>
            {#if canOpenArticle(entry)}
              <button
                type="button"
                class="wiki-changelog-link"
                onclick={() => openArticle(entry.article_id as string)}
                title="Open this article"
              >{entry.title_at_change}</button>
            {:else}
              <!-- Deleted OR article_id null - render plain. The
                   primitive collapses both gates into one
                   predicate; see canOpenArticle's docstring for
                   the belt-and-braces rationale. -->
              <span class="wiki-changelog-title-gone">
                {entry.title_at_change}
              </span>
            {/if}
            <time
              class="wiki-changelog-stamp"
              datetime={entry.created_at}
            >{formatChangelogStamp(entry.created_at)}</time>
          </div>
          <p class="wiki-changelog-message">{entry.message}</p>
        </li>
      {/each}
    </ul>

    {#if !exhausted}
      <div class="wiki-changelog-more">
        <button
          type="button"
          onclick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading...' : 'Load more'}
        </button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .wiki-changelog-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .wiki-changelog-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.25rem;
  }
  .wiki-changelog-title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }
  .wiki-changelog-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .wiki-changelog-row {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 0.9rem;
    background: var(--surface);
  }
  .wiki-changelog-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  /* Kind chips - colored to read at a glance. Greens for adds, amber
     for edits, red for deletes. Each pairs a tint background with a
     darker border so the chip survives both light and dark themes
     without per-theme overrides. Record writes (record_*) reuse the
     same colour family as their article counterpart; the "record"
     qualifier in the label is what tells them apart. */
  .wiki-changelog-kind {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-pill);
    border: 1px solid transparent;
  }
  .wiki-changelog-kind.kind-create,
  .wiki-changelog-kind.kind-record_create {
    background: color-mix(in srgb, #15803d 15%, transparent);
    border-color: color-mix(in srgb, #15803d 40%, transparent);
    color: #15803d;
  }
  .wiki-changelog-kind.kind-update,
  .wiki-changelog-kind.kind-record_update {
    background: color-mix(in srgb, #b45309 15%, transparent);
    border-color: color-mix(in srgb, #b45309 40%, transparent);
    color: #b45309;
  }
  .wiki-changelog-kind.kind-delete,
  .wiki-changelog-kind.kind-record_delete {
    background: color-mix(in srgb, #b91c1c 15%, transparent);
    border-color: color-mix(in srgb, #b91c1c 40%, transparent);
    color: #b91c1c;
  }
  .wiki-changelog-link {
    background: none;
    border: none;
    color: var(--link, var(--text));
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-align: left;
  }
  .wiki-changelog-link:hover {
    color: var(--link-hover, var(--text));
  }
  .wiki-changelog-title-gone {
    color: var(--muted);
    font-style: italic;
  }
  .wiki-changelog-stamp {
    color: var(--muted);
    font-size: 0.8rem;
    margin-left: auto;
    white-space: nowrap;
  }
  .wiki-changelog-message {
    margin: 0;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .wiki-changelog-more {
    margin-top: 1rem;
    display: flex;
    justify-content: center;
  }
</style>
