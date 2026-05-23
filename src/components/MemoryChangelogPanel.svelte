<script lang="ts">
  /*
   * Inline memory changelog. Mounted in the Memories panel's no-
   * selection branch as the default surface when the drawer tab is open
   * but no memory is picked - the analogue of WikiChangelogPanel's role
   * in the Wiki tab. Renders the user's memory_changelog table (one row
   * per content-affecting create / update / delete / librarian
   * consolidation), newest first, with "Load more" pagination keyed by
   * created_at.
   *
   * Clicking an entry whose memory still exists fetches that row, upserts
   * it into memoriesStore so the detail card can resolve it (the card
   * reads from the active result set, not by id), then selects it via
   * route.memory. This mirrors openSimilar in Memories.svelte - without
   * the upsert the link would land on the "not in current results" empty
   * state whenever the changelog row falls outside the active search
   * window. Entries whose memory has been deleted render the label
   * snapshot as plain text (the "Deleted" chip carries the signal).
   *
   * Holds an in-memory page list; nothing here is persisted across panel
   * teardown, so reopening (switching tabs and back, or deselecting a
   * memory) always fetches the first page fresh.
   */
  import { app } from '$lib/state.svelte';
  import { navigate } from '$lib/routing.svelte';
  import { onMemoryChange } from '$lib/memory-events';
  import { upsertMemoryRow } from '$lib/memories-store.svelte';
  import type { MemoryChangelogEntry } from '$lib/supabase';
  import {
    PAGE_SIZE,
    canOpenMemory,
    formatChangelogStamp,
    isExhausted,
    kindLabel,
  } from '$lib/ui/memory-changelog-panel';

  let entries = $state<MemoryChangelogEntry[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  // True when the last fetched page came back smaller than PAGE_SIZE -
  // i.e. we've reached the tail and "Load more" has nothing to ask for.
  let exhausted = $state(false);

  /**
   * Fetch the first page. Used on mount and on a cross-surface memory
   * change (a chat-side write or a librarian consolidation landing a
   * row while the panel is visible). Resets `exhausted` because a fresh
   * write at the head means there's at least one new row even if the
   * tail hadn't changed.
   */
  async function loadFirstPage(): Promise<void> {
    if (!app.supabase) return;
    loading = true;
    error = null;
    try {
      const rows = await app.supabase.listMemoryChangelog({ limit: PAGE_SIZE });
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
      const rows = await app.supabase.listMemoryChangelog({
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
    // mounted. The memory-change event fires from the content-write
    // tools and the librarian - any of them could have appended a row.
    const off = onMemoryChange(() => {
      void loadFirstPage();
    });
    return () => off();
  });

  async function openMemory(memoryId: string): Promise<void> {
    if (!app.supabase) return;
    // The detail card resolves against the active result set, so inject
    // the row first - otherwise a changelog entry outside the current
    // search window lands on the "not in current results" empty state.
    // A row that vanished between listing and click (rare) just falls
    // through to navigate, which shows that same empty state.
    try {
      const mem = await app.supabase.getMemoryById(memoryId);
      if (mem) upsertMemoryRow(mem);
    } catch {
      // Best-effort hydration; navigate regardless so the click isn't a
      // dead end. Worst case the card shows "clear the search to find it".
    }
    navigate({ memory: memoryId });
  }
</script>

<section class="memory-changelog-panel" aria-label="Memory changelog">
  <header class="memory-changelog-header">
    <h2 class="memory-changelog-title">Memory changelog</h2>
  </header>

  {#if loading}
    <p class="subtle">Loading...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if entries.length === 0}
    <p class="subtle">
      No memory changes yet. Anything added, edited, deleted, or merged -
      by you, by the assistant, or by the librarian - lands here with a
      one-line note.
    </p>
  {:else}
    <ul class="memory-changelog-list">
      {#each entries as entry (entry.id)}
        <li class="memory-changelog-row">
          <div class="memory-changelog-row-head">
            <span
              class="memory-changelog-kind kind-{entry.kind}"
              aria-label={kindLabel(entry.kind)}
              title={kindLabel(entry.kind)}
            >{kindLabel(entry.kind)}</span>
            {#if canOpenMemory(entry)}
              <button
                type="button"
                class="memory-changelog-link"
                onclick={() => openMemory(entry.memory_id as string)}
                title="Open this memory"
              >{entry.label_at_change}</button>
            {:else}
              <!-- Deleted OR memory_id null - render plain. The primitive
                   collapses both gates into one predicate; see
                   canOpenMemory's docstring for the rationale. -->
              <span class="memory-changelog-label-gone">
                {entry.label_at_change}
              </span>
            {/if}
            <time
              class="memory-changelog-stamp"
              datetime={entry.created_at}
            >{formatChangelogStamp(entry.created_at)}</time>
          </div>
          <p class="memory-changelog-message">{entry.message}</p>
        </li>
      {/each}
    </ul>

    {#if !exhausted}
      <div class="memory-changelog-more">
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
  .memory-changelog-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .memory-changelog-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.25rem;
  }
  .memory-changelog-title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }
  .memory-changelog-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .memory-changelog-row {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
    background: var(--surface);
  }
  .memory-changelog-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  /* Three kind chips - colored to read at a glance. Green for adds,
     amber for edits (incl. librarian merges), red for deletes. Each
     pairs a tint background with a darker border so the chip survives
     both light and dark themes without per-theme overrides. */
  .memory-changelog-kind {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    border: 1px solid transparent;
  }
  .memory-changelog-kind.kind-create {
    background: color-mix(in srgb, #15803d 15%, transparent);
    border-color: color-mix(in srgb, #15803d 40%, transparent);
    color: #15803d;
  }
  .memory-changelog-kind.kind-update {
    background: color-mix(in srgb, #b45309 15%, transparent);
    border-color: color-mix(in srgb, #b45309 40%, transparent);
    color: #b45309;
  }
  .memory-changelog-kind.kind-delete {
    background: color-mix(in srgb, #b91c1c 15%, transparent);
    border-color: color-mix(in srgb, #b91c1c 40%, transparent);
    color: #b91c1c;
  }
  .memory-changelog-link {
    background: none;
    border: none;
    color: var(--link, var(--text));
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-align: left;
  }
  .memory-changelog-link:hover {
    color: var(--link-hover, var(--text));
  }
  .memory-changelog-label-gone {
    color: var(--muted);
    font-style: italic;
  }
  .memory-changelog-stamp {
    color: var(--muted);
    font-size: 0.8rem;
    margin-left: auto;
    white-space: nowrap;
  }
  .memory-changelog-message {
    margin: 0;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .memory-changelog-more {
    margin-top: 1rem;
    display: flex;
    justify-content: center;
  }
</style>
