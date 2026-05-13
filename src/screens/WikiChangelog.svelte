<script lang="ts">
  /*
   * Wiki changelog modal. Renders the user's wiki_changelog table -
   * one row per individual create/update/delete - newest first, with
   * "Load more" pagination keyed by created_at. Reached from the top-
   * bar "history" button on the Wiki tab in Chat.svelte; closes via
   * Escape, backdrop click, or the top-right X (same chrome as the
   * Help and Settings modals).
   *
   * Entries with a still-extant article link to it (clicking switches
   * the drawer to the Wiki tab and selects the article); entries whose
   * underlying article has been deleted render the title snapshot as
   * plain text. The kind chip (Added / Edited / Deleted) makes the
   * three states scannable at a glance.
   *
   * The fetch is cursor-paged on created_at desc - see
   * supabase.listWikiChangelog. Holds a small in-memory list and lazy-
   * loads more on demand; nothing here is persisted across modal
   * close, so reopening always fetches the first page fresh.
   */
  import { app } from '$lib/state.svelte';
  import { navigate } from '$lib/routing.svelte';
  import { onWikiChange } from '$lib/wiki-events';
  import type { WikiChangelogEntry } from '$lib/supabase';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  // 50 reads as "a useful screenful" without dragging the first paint.
  // Bumping it costs little - the index makes the range scan cheap -
  // but more rows per request means more layout work the moment the
  // modal opens, and 50 hits a sweet spot.
  const PAGE_SIZE = 50;

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
   * change (the autonomous agent landing a new row while the modal is
   * open). Resets `exhausted` because a fresh write at the head means
   * there's at least one new row even if the tail hadn't changed.
   */
  async function loadFirstPage(): Promise<void> {
    if (!app.supabase) return;
    loading = true;
    error = null;
    try {
      const rows = await app.supabase.listWikiChangelog({ limit: PAGE_SIZE });
      entries = rows;
      exhausted = rows.length < PAGE_SIZE;
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
      if (rows.length < PAGE_SIZE) exhausted = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    void loadFirstPage();
    // Keep the modal in sync with cross-surface writes while it's
    // open. The wiki-change event fires from the tool path, the
    // librarian, and the in-panel direct edits - any of them could
    // have appended a row.
    const off = onWikiChange(() => {
      void loadFirstPage();
    });
    return () => off();
  });

  function kindLabel(k: WikiChangelogEntry['kind']): string {
    if (k === 'create') return 'Added';
    if (k === 'update') return 'Edited';
    return 'Deleted';
  }

  // Compact locale-aware timestamp. Matches the format Cookbook's
  // version-history rows use so the two changelog-style surfaces read
  // the same. Falls back to the raw ISO string on parse failure
  // rather than rendering an "Invalid Date".
  function formatStamp(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function openArticle(articleId: string): void {
    // Switch the drawer to the Wiki tab and select the article so the
    // modal closes and the user lands on the entry. The drawer flip
    // is needed because the changelog modal is reachable from any
    // tab, not just the Wiki tab.
    navigate({
      modal: null,
      drawer: 'wiki',
      wiki_article_id: articleId,
    });
    onClose();
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center wiki-changelog-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div
    class="wiki-changelog-shell"
    role="dialog"
    aria-modal="true"
    aria-label="Wiki changelog"
  >
    <header class="wiki-changelog-header">
      <h1 class="wiki-changelog-title">Wiki changelog</h1>
      <button
        type="button"
        class="wiki-changelog-close"
        onclick={onClose}
        aria-label="Close changelog"
        title="Close"
      >&times;</button>
    </header>

    <section class="wiki-changelog-content">
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
                {#if entry.article_id && entry.kind !== 'delete'}
                  <button
                    type="button"
                    class="wiki-changelog-link"
                    onclick={() => openArticle(entry.article_id as string)}
                    title="Open this article"
                  >{entry.title_at_change}</button>
                {:else}
                  <!-- article_id null (deleted) OR delete kind: render
                       plain. For delete-kind we deliberately don't link
                       even if article_id is still set (it won't be -
                       the FK set null fires on delete - but the guard
                       is belt-and-braces). -->
                  <span class="wiki-changelog-title-gone">
                    {entry.title_at_change}
                  </span>
                {/if}
                <time
                  class="wiki-changelog-stamp"
                  datetime={entry.created_at}
                >{formatStamp(entry.created_at)}</time>
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
  </div>
</div>

<style>
  /* Shell + chrome mirror the Help modal so the three doc-style
     modals (Help, Settings, this) read as the same surface. The
     shared `.wiki-changelog-backdrop` z-index is set in styles.css
     alongside the other modal backdrops. */
  .wiki-changelog-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 52rem;
    display: grid;
    grid-template-rows: auto 1fr;
    height: min(40rem, 85vh);
    overflow: hidden;
  }
  .wiki-changelog-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
  }
  .wiki-changelog-title {
    flex: 1;
    min-width: 0;
    font-size: 1rem;
    margin: 0;
    padding: 0 0.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wiki-changelog-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
    width: 2rem;
    height: 2rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    line-height: 1;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 50%;
    cursor: pointer;
  }
  .wiki-changelog-close:hover {
    background: var(--bg-2);
  }
  .wiki-changelog-content {
    padding: 1rem 1.25rem;
    overflow-y: auto;
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
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
    background: var(--surface);
  }
  .wiki-changelog-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  /* Three kind chips - colored to read at a glance. Greens for adds,
     amber for edits, red for deletes. Each pairs a tint background
     with a darker border so the chip survives both light and dark
     themes without per-theme overrides. */
  .wiki-changelog-kind {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    border: 1px solid transparent;
  }
  .wiki-changelog-kind.kind-create {
    background: color-mix(in srgb, #15803d 15%, transparent);
    border-color: color-mix(in srgb, #15803d 40%, transparent);
    color: #15803d;
  }
  .wiki-changelog-kind.kind-update {
    background: color-mix(in srgb, #b45309 15%, transparent);
    border-color: color-mix(in srgb, #b45309 40%, transparent);
    color: #b45309;
  }
  .wiki-changelog-kind.kind-delete {
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
