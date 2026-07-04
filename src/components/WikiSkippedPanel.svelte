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
   * Clicking a row navigates to the underlying conversation. The
   * Retry button asks the venice function (/wiki-retry) to re-run the
   * agent against the thread; the run claims the thread and executes
   * under EdgeRuntime.waitUntil, so it survives a reload mid-retry. A
   * successful run clears the skip marker server-side and the row gains
   * an inline result chip.
   * Editing the conversation also naturally re-eligibilises the
   * thread for the background sweep (the eligibility predicate in
   * `claim_next_thread_for_wiki` gates on the terminal message id
   * differing from the pointer), and a successful sweep run clears
   * the skip marker via `mark_thread_wiki_processed_if_claimed`,
   * draining the row from this list.
   *
   * The result chip and per-row error are in-memory and reset on panel
   * teardown. The retry IN-FLIGHT state is not: each row carries a
   * server-side `retrying` flag (a held per-thread wiki claim), so a tab
   * that reloaded while a retry was running re-renders the disabled
   * "Retrying..." button from that durable claim rather than losing it.
   */
  import { app } from '$lib/state.svelte';
  import { navigate } from '$lib/routing.svelte';
  import { onWikiChange, emitWikiChange } from '$lib/wiki-events';
  import {
    displayTitle,
    formatSkipTimestamp,
    retryResultHeadline,
    visibleSkippedRows,
  } from '$lib/ui/wiki-skipped-panel';

  interface SkippedRow {
    threadId: string;
    title: string | null;
    lastSkipAt: string;
    lastSkipReason: string | null;
    // Server-side claim state: a manual retry (or the sweep's recovery
    // branch) is processing this thread right now. Durable, unlike the
    // in-memory `retrying` map below, so a tab that reloaded mid-retry
    // recovers the in-flight state from this rather than losing it.
    retrying: boolean;
  }

  let rows = $state<SkippedRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /**
   * Per-row retry state. Keyed by thread id so a click on one row's
   * Retry button only spins that row's button + only surfaces that
   * row's error / result inline.
   *
   * `retryResult` holds the agent's tool-call count + reasoning
   * summary on a successful retry. The row stays visible (rather
   * than dropping immediately) so the user can read what the agent
   * decided - especially important when the agent returned done
   * with zero tool calls, which means the skip cleared but nothing
   * landed in the changelog. Dismissing removes the row locally;
   * the next `load()` call wouldn't include it anyway since the
   * skip marker is already cleared in the DB.
   */
  let retrying = $state<Record<string, boolean>>({});
  let retryError = $state<Record<string, string>>({});
  let retryResult = $state<
    Record<string, { toolCalls: number; reasoning: string }>
  >({});
  let dismissed = $state<Record<string, true>>({});

  const visibleRows = $derived(visibleSkippedRows(rows, dismissed));

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

  async function retryRow(row: SkippedRow): Promise<void> {
    if (!app.supabase) return;
    if (retrying[row.threadId]) return;
    // Best-effort: wipe the previous error / result inline before
    // the new run so the user doesn't read a stale message while the
    // spinner is spinning.
    delete retryError[row.threadId];
    retryError = { ...retryError };
    delete retryResult[row.threadId];
    retryResult = { ...retryResult };
    retrying[row.threadId] = true;
    retrying = { ...retrying };
    try {
      // The whole retry cycle runs server-side (the venice function's
      // /wiki-retry route): terminal-message resolution, the agent's
      // tool loop with its content-classifier fallback, and the
      // pointer advance that clears the skip marker. This is a thin
      // authenticated POST; the result union mirrors what the old
      // in-browser agent returned.
      const result = await app.supabase.retryWikiThread(row.threadId);
      if (result.kind === 'ok') {
        // Successful run. Stash the agent's tool-call count + final
        // reasoning so the row can show what actually happened
        // before the user dismisses it. Critical when toolCalls is
        // 0: the skip cleared but nothing landed in the changelog,
        // and silently dropping the row would leave the user
        // confused (we just shipped a fix for exactly that). Emit
        // the wiki-change event so sibling surfaces (changelog,
        // list) refetch in case there WERE edits.
        retryResult[row.threadId] = {
          toolCalls: result.toolCalls,
          reasoning: result.reasoning,
        };
        retryResult = { ...retryResult };
        emitWikiChange();
        return;
      }
      if (result.kind === 'busy') {
        // The thread was already claimed (the hourly sweep, or a
        // concurrent retry from another tab). Not an error - refresh so
        // the row's server `retrying` flag reflects the live claim and
        // the button shows the in-flight state instead.
        await load();
        return;
      }
      retryError[row.threadId] =
        result.kind === 'no-op' ? result.reason : result.error;
      retryError = { ...retryError };
    } catch (err) {
      retryError[row.threadId] =
        err instanceof Error ? err.message : String(err);
      retryError = { ...retryError };
    } finally {
      retrying[row.threadId] = false;
      retrying = { ...retrying };
    }
  }

  function dismissRow(threadId: string): void {
    // Local-only: the skip marker was already cleared in the DB by
    // the server-side retry. Hiding it from the rendered list
    // is enough; on the next mount, listWikiSkippedThreads won't
    // include this thread anyway.
    dismissed[threadId] = true;
    dismissed = { ...dismissed };
  }

  $effect(() => {
    void load();
    // The wiki-change event fires when an article row changes -
    // direct edits in the Wiki UI, or the wiki_articles realtime
    // subscription relaying a server-side agent write. Skip-stamping
    // doesn't touch the articles table, so the panel gets no direct
    // signal when the sweep adds a NEW skip row - a stale list while
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
  {:else if visibleRows.length === 0}
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
      {#each visibleRows as row (row.threadId)}
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
          {#if retryResult[row.threadId]}
            <!-- Successful retry. The skip is cleared in the DB; the
                 row is staying visible specifically so the user can
                 see what the agent decided before dismissing.
                 Especially important when toolCalls === 0: nothing
                 landed in the changelog and silently dropping the
                 row was what confused users before this branch. -->
            <div class="wiki-skipped-result" role="status">
              <p class="wiki-skipped-result-headline">
                {retryResultHeadline(retryResult[row.threadId].toolCalls)}
              </p>
              <p class="wiki-skipped-result-reasoning">
                <span class="wiki-skipped-result-label">Reasoning:</span>
                {retryResult[row.threadId].reasoning}
              </p>
            </div>
          {/if}
          <div class="wiki-skipped-row-foot">
            {#if retryResult[row.threadId]}
              <button
                type="button"
                class="wiki-skipped-dismiss"
                onclick={() => dismissRow(row.threadId)}
                title="Hide this row"
              >
                Dismiss
              </button>
            {:else}
              <!-- In-flight when THIS tab is retrying (local map) OR the
                   server reports a held claim (row.retrying) - the latter
                   is how a reloaded tab recovers the state. For the
                   responding tab row.retrying stays stale-false (the claim
                   landed after the last load), so its own local flag drives
                   the spinner and clears it cleanly when the run settles. -->
              <button
                type="button"
                class="wiki-skipped-retry"
                onclick={() => retryRow(row)}
                disabled={retrying[row.threadId] || row.retrying}
                title="Re-run the wiki agent against this conversation now"
              >
                {retrying[row.threadId] || row.retrying ? 'Retrying...' : 'Retry'}
              </button>
              {#if retryError[row.threadId]}
                <span class="wiki-skipped-retry-error" role="status">
                  {retryError[row.threadId]}
                </span>
              {/if}
            {/if}
          </div>
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
    border-radius: var(--radius);
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
  .wiki-skipped-row-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .wiki-skipped-retry {
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .wiki-skipped-retry:hover:not(:disabled) {
    background: var(--surface-hover, var(--surface));
  }
  .wiki-skipped-retry:disabled {
    cursor: progress;
    opacity: 0.7;
  }
  .wiki-skipped-retry-error {
    color: var(--danger, #b91c1c);
    font-size: 0.85rem;
    word-break: break-word;
  }
  .wiki-skipped-result {
    margin-top: 0.5rem;
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, #15803d 10%, transparent);
    border: 1px solid color-mix(in srgb, #15803d 30%, transparent);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .wiki-skipped-result-headline {
    margin: 0;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--text);
  }
  .wiki-skipped-result-reasoning {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text);
    word-break: break-word;
  }
  .wiki-skipped-result-label {
    color: var(--muted);
    font-weight: 600;
    margin-right: 0.25rem;
  }
  .wiki-skipped-dismiss {
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .wiki-skipped-dismiss:hover {
    background: var(--surface-hover, var(--surface));
  }
</style>
