<script lang="ts">
  /*
   * Inline wiki skipped-threads panel. Sibling of WikiChangelogPanel
   * and the librarian confirmation strip; the third "page" inside the
   * Wiki tab's main area. Mounted from Wiki.svelte when the
   * skippedViewOpen flag is true (set by the top-bar alert button in
   * Chat.svelte, cleared by navigating to an article or the
   * changelog).
   *
   * Renders threads whose `wiki_last_skip_at` is non-null - i.e. the
   * autonomous wiki agent hit the per-thread failure cap on its
   * terminal message and advanced the pointer rather than retrying
   * forever. The dominant cause in production is Venice's content
   * classifier rejecting a conversation body; the displayed reason
   * (trimmed Venice error message) lets the user identify it without
   * opening the Logs drawer.
   *
   * Clicking a row navigates to the underlying conversation. There is
   * no "Retry" affordance: the eligibility predicate in
   * `claim_next_thread_for_wiki` is gated on the terminal message id
   * differing from the pointer, so editing the conversation (adding,
   * removing, or modifying a turn) is what naturally re-eligibilises
   * it. A successful next run clears the skip marker via
   * `mark_thread_wiki_processed_if_claimed`, draining the row from
   * this list.
   *
   * Holds an in-memory snapshot; nothing here is persisted across
   * panel teardown, so flipping tabs and back fetches fresh.
   */
  import { app } from '$lib/state.svelte';
  import { navigate } from '$lib/routing.svelte';
  import { onWikiChange } from '$lib/wiki-events';
  import {
    displayTitle,
    formatSkipTimestamp,
  } from '$lib/ui/wiki-skipped-panel';

  interface SkippedRow {
    threadId: string;
    title: string | null;
    lastSkipAt: string;
    lastSkipReason: string | null;
  }

  let rows = $state<SkippedRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    if (!app.supabase) return;
    loading = true;
    error = null;
    try {
      rows = await app.supabase.listWikiSkippedThreads();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
    // The wiki-change event fires after the worker successfully
    // processes a thread (which CAN clear a skip marker via the mark
    // RPC). The panel doesn't get a direct signal on skip-stamping
    // because the worker doesn't emit a wiki-change event for that
    // case - the article store didn't change - so a stale list while
    // the panel is open is possible. The fix-once-stale path is a
    // panel reopen; the cost of polling here would outweigh the
    // benefit for a low-frequency surface.
    const off = onWikiChange(() => {
      void load();
    });
    return () => off();
  });

  function openThread(threadId: string): void {
    // Mirrors the patch openSourceThread uses for inline ?cid= links
    // in the wiki body: jump to the chat surface, clear the wiki tab
    // so the user lands on the conversation rather than staying in
    // the wiki panel with a thread id behind the scenes.
    navigate({ cid: threadId, drawer: null, wiki_article_id: null });
  }
</script>

<section class="wiki-skipped-panel" aria-label="Wiki skipped threads">
  <header class="wiki-skipped-header">
    <h2 class="wiki-skipped-title">Skipped by the wiki agent</h2>
  </header>

  {#if loading}
    <p class="subtle">Loading...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if rows.length === 0}
    <p class="subtle">
      No skipped threads. The autonomous wiki agent processes
      conversations a day after they settle; if it errors out
      repeatedly on the same conversation (Venice's content classifier
      is the dominant cause), the thread lands here so you can see
      which one and why.
    </p>
  {:else}
    <p class="subtle wiki-skipped-intro">
      The agent gave up on these conversations after repeated errors.
      Editing the conversation (or adding a new turn) lets the agent
      try again on the next sweep; a successful run drops the row from
      this list.
    </p>
    <ul class="wiki-skipped-list">
      {#each rows as row (row.threadId)}
        <li class="wiki-skipped-row">
          <div class="wiki-skipped-row-head">
            <button
              type="button"
              class="wiki-skipped-link"
              onclick={() => openThread(row.threadId)}
              title="Open this conversation"
            >{displayTitle(row.title)}</button>
            <time
              class="wiki-skipped-stamp"
              datetime={row.lastSkipAt}
            >{formatSkipTimestamp(row.lastSkipAt)}</time>
          </div>
          {#if row.lastSkipReason}
            <p class="wiki-skipped-reason">{row.lastSkipReason}</p>
          {:else}
            <p class="wiki-skipped-reason subtle">
              No error detail was captured.
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .wiki-skipped-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .wiki-skipped-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.25rem;
  }
  .wiki-skipped-title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }
  .wiki-skipped-intro {
    margin: 0;
  }
  .wiki-skipped-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .wiki-skipped-row {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
    background: var(--surface);
  }
  .wiki-skipped-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  .wiki-skipped-link {
    background: none;
    border: none;
    color: var(--link, var(--text));
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 0;
    text-align: left;
  }
  .wiki-skipped-link:hover {
    color: var(--link-hover, var(--text));
  }
  .wiki-skipped-stamp {
    color: var(--muted);
    font-size: 0.8rem;
    margin-left: auto;
    white-space: nowrap;
  }
  .wiki-skipped-reason {
    margin: 0;
    color: var(--text);
    font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
