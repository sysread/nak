<script lang="ts">
  /*
   * Daily digest panel. Renders the conversation_digests table (one
   * agent-written recap per local calendar day), newest day first,
   * with "Load more" pagination keyed by digest_date - the same
   * changelog-page shape as WikiChangelogPanel / MemoryChangelogPanel.
   *
   * Mounted from Chat.svelte's chats main panel when route.digest is
   * set (the calendar button next to "New conversation"); it is NOT
   * the tab's default surface - the empty new-conversation view keeps
   * that role. Each card lists the day's conversations as a table;
   * clicking a title deep-links into that thread via the onOpenThread
   * callback (which also closes this panel). Titles are snapshots
   * taken at digest time, so a card stays readable after the
   * underlying conversation is deleted - a deleted thread's link just
   * lands on an empty transcript.
   *
   * Holds an in-memory page list; nothing here is persisted across
   * panel teardown, so reopening always fetches the first page fresh.
   */
  import { app } from '$lib/state.svelte';
  import type { ConversationDigest } from '$lib/supabase';
  import {
    PAGE_SIZE,
    conversationCountLabel,
    formatDigestDate,
    isExhausted,
  } from '$lib/ui/digest-panel';

  interface Props {
    /** Open a digested conversation. Chat.svelte navigates to the
     * thread and clears route.digest in the same patch. */
    onOpenThread: (threadId: string) => void;
  }
  let { onOpenThread }: Props = $props();

  let digests = $state<ConversationDigest[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  // True when the last fetched page came back smaller than PAGE_SIZE -
  // the tail is reached and "Load more" has nothing to ask for.
  let exhausted = $state(false);

  async function loadFirstPage(): Promise<void> {
    if (!app.supabase) return;
    loading = true;
    error = null;
    try {
      const rows = await app.supabase.listConversationDigests({ limit: PAGE_SIZE });
      digests = rows;
      exhausted = isExhausted(rows.length);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!app.supabase || loadingMore || exhausted) return;
    const tail = digests[digests.length - 1];
    if (!tail) return;
    loadingMore = true;
    error = null;
    try {
      const rows = await app.supabase.listConversationDigests({
        limit: PAGE_SIZE,
        before: tail.digest_date,
      });
      digests = [...digests, ...rows];
      if (isExhausted(rows.length)) exhausted = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    void loadFirstPage();
  });
</script>

<section class="digest-panel" aria-label="Daily digest">
  <header class="digest-header">
    <h2 class="digest-title">Daily digest</h2>
  </header>

  {#if loading}
    <p class="subtle">Loading...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if digests.length === 0}
    <p class="subtle">
      No digests yet. Once a day, after midnight in your timezone, an
      agent summarizes the previous day's conversations and files the
      recap here.
    </p>
  {:else}
    <ul class="digest-list">
      {#each digests as digest (digest.id)}
        <li class="digest-day">
          <div class="digest-day-head">
            <h3 class="digest-day-date">{formatDigestDate(digest.digest_date)}</h3>
            <span class="digest-day-count">
              {conversationCountLabel(digest.threads.length)}
            </span>
          </div>
          <p class="digest-day-summary">{digest.summary}</p>
          {#if digest.threads.length > 0}
            <table class="digest-table">
              <thead>
                <tr>
                  <th class="digest-th-title">Conversation</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {#each digest.threads as thread (thread.thread_id)}
                  <tr>
                    <td class="digest-td-title">
                      <button
                        type="button"
                        class="digest-thread-link"
                        onclick={() => onOpenThread(thread.thread_id)}
                        title="Open this conversation"
                      >{thread.title}</button>
                    </td>
                    <td class="digest-td-summary">{thread.summary}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </li>
      {/each}
    </ul>

    {#if !exhausted}
      <div class="digest-more">
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
  .digest-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 60rem;
    margin: 0 auto;
    width: 100%;
    padding: 1rem;
    overflow-y: auto;
  }
  .digest-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.25rem;
  }
  .digest-title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }
  .digest-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .digest-day {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 0.9rem;
    background: var(--surface);
  }
  .digest-day-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  .digest-day-date {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .digest-day-count {
    color: var(--muted);
    font-size: 0.8rem;
    margin-left: auto;
    white-space: nowrap;
  }
  .digest-day-summary {
    margin: 0 0 0.5rem;
    color: var(--text);
    word-break: break-word;
  }
  /* The per-conversation table scrolls inside the card on narrow
     viewports rather than forcing the page wide. */
  .digest-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
    display: block;
    overflow-x: auto;
  }
  .digest-table th {
    text-align: left;
    color: var(--muted);
    font-weight: 600;
    padding: 0.35rem 0.6rem 0.35rem 0;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .digest-table td {
    padding: 0.4rem 0.6rem 0.4rem 0;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .digest-table tr:last-child td {
    border-bottom: none;
  }
  .digest-td-title {
    min-width: 10rem;
  }
  .digest-td-summary {
    word-break: break-word;
  }
  /* Mobile: a phone-width viewport squeezes the two-column table into
     character-wrapped slivers, so stack each row instead - title on
     one line, summary below - and drop the column headers, which mean
     nothing once the columns are gone. Breakpoint matches the
     top-bar's 720px mobile cutover. */
  @media (max-width: 720px) {
    .digest-table,
    .digest-table tbody,
    .digest-table tr,
    .digest-table td {
      display: block;
    }
    .digest-table thead {
      display: none;
    }
    .digest-table td {
      padding: 0;
      border-bottom: none;
    }
    .digest-table tr {
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }
    .digest-table tr:last-child {
      border-bottom: none;
    }
    .digest-td-title {
      min-width: 0;
      margin-bottom: 0.15rem;
    }
  }

  .digest-thread-link {
    background: none;
    border: none;
    color: var(--link, var(--text));
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-align: left;
  }
  .digest-thread-link:hover {
    color: var(--link-hover, var(--text));
  }
  .digest-more {
    margin-top: 1rem;
    display: flex;
    justify-content: center;
  }
</style>
