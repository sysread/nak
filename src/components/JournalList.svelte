<script lang="ts">
  /*
   * Sidebar journal listing. Shown in the left drawer when the Journal
   * tab is active. One row per date - multiple entries on the same day
   * all open the same day-view, so collapsing to a date index is the
   * right granularity for a browse surface.
   *
   * Empty query: aggregates the eagerly-loaded `journal.entries` by
   * `entry_date`, newest day first. Substring fallback is intentionally
   * NOT used - the embed-then-search pipeline below replaces it so the
   * sidebar matches the assistant's `journal_search` tool (and the
   * wiki sidebar) shape.
   *
   * Active query: embeds the query via Venice and calls
   * `supabase.searchJournalEntries` (semantic-first merge with ILIKE
   * fallback inside Supabase). The returned rows are aggregated by
   * date, ordered by the best per-date similarity score so the closest
   * day floats to the top. Loading state replaces the listing with a
   * Scanner.
   *
   * Clicking a date calls navigate({ journal_date: 'YYYY-MM-DD' }), which
   * switches the main panel to JournalPanel showing that day's entries.
   */
  import { app } from '$lib/state.svelte';
  import { navigate, route } from '$lib/routing.svelte';
  import { journal } from '$lib/journal-store.svelte';
  import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '$lib/models';
  import type { JournalEntry } from '$lib/supabase';
  import Scanner from './Scanner.svelte';

  // Parent (Chat shell) passes a callback that dismisses the mobile
  // drawer once the main panel has navigated to the chosen day.
  // Optional so the component is still usable in contexts that don't
  // own a drawer.
  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  let query = $state('');
  let searchResults = $state<JournalEntry[]>([]);
  let searchBusy = $state(false);
  let searchError = $state<string | null>(null);
  let searchAbort: AbortController | null = null;

  const SEARCH_DEBOUNCE_MS = 200;
  // Match the journal_search tool's max so the sidebar surfaces every
  // day the assistant could reach. Aggregated by date downstream so
  // the actual row count in the drawer is the unique-date count.
  const JOURNAL_SEARCH_LIMIT = 50;

  $effect(() => {
    const q = query.trim();
    if (q.length === 0) {
      searchResults = [];
      searchBusy = false;
      searchError = null;
      if (searchAbort) searchAbort.abort();
      searchAbort = null;
      return;
    }
    if (!app.supabase) return;
    const timer = setTimeout(() => {
      void runJournalSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  async function runJournalSearch(q: string): Promise<void> {
    if (!app.supabase) return;
    // Supersede any in-flight search so a slow embed call from a
    // stale query can't clobber a newer one.
    if (searchAbort) searchAbort.abort();
    const ctl = new AbortController();
    searchAbort = ctl;
    searchBusy = true;
    searchError = null;
    try {
      let queryEmbedding: number[] | null = null;
      if (app.venice) {
        try {
          const resp = await app.venice.embed({
            model: VENICE_EMBEDDING_MODEL,
            input: q,
            signal: ctl.signal,
          });
          const raw = resp.data[0]?.embedding;
          if (raw && raw.length > 0) {
            queryEmbedding = padEmbeddingForStorage(raw);
          }
        } catch {
          // Best-effort: ILIKE-only is still useful. The supabase
          // method treats a null embedding as "skip the vector RPC".
        }
      }
      if (ctl.signal.aborted) return;
      const hits = await app.supabase.searchJournalEntries({
        query: q,
        queryEmbedding,
        limit: JOURNAL_SEARCH_LIMIT,
      });
      if (ctl.signal.aborted) return;
      searchResults = hits;
    } catch (err) {
      if (!ctl.signal.aborted) {
        searchError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (searchAbort === ctl) {
        searchAbort = null;
        searchBusy = false;
      }
    }
  }

  interface DayRow {
    entry_date: string;
    count: number;
  }

  // Empty query: aggregate the eagerly-loaded list by date, newest
  // first. journal.entries is already sorted newest-day-first; the
  // insertion-ordered Map preserves that.
  const browseDays = $derived.by<DayRow[]>(() => {
    const byDay = new Map<string, number>();
    for (const e of journal.entries) {
      byDay.set(e.entry_date, (byDay.get(e.entry_date) ?? 0) + 1);
    }
    return Array.from(byDay, ([entry_date, count]) => ({ entry_date, count }));
  });

  // Active query: aggregate the server hits by date, ranking days by
  // their best per-date similarity. ILIKE-only rows lack `similarity`;
  // they fall to the bottom (similarity -Infinity proxy). Within a day
  // we take the max so a day with one strong match outranks a day
  // with several weak ones.
  const searchDays = $derived.by<DayRow[]>(() => {
    interface Bucket {
      count: number;
      best: number;
      firstIdx: number;
    }
    const byDay = new Map<string, Bucket>();
    searchResults.forEach((e, idx) => {
      const sim = typeof e.similarity === 'number' ? e.similarity : -Infinity;
      const cur = byDay.get(e.entry_date);
      if (cur) {
        cur.count += 1;
        if (sim > cur.best) cur.best = sim;
      } else {
        byDay.set(e.entry_date, { count: 1, best: sim, firstIdx: idx });
      }
    });
    return Array.from(byDay, ([entry_date, b]) => ({
      entry_date,
      count: b.count,
      best: b.best,
      firstIdx: b.firstIdx,
    }))
      .sort((a, b) => {
        // Higher similarity first. Tie-break on the position the
        // first matching entry came back in (preserves the supabase
        // method's exact-vs-semantic merge order for unscored rows).
        if (a.best !== b.best) return b.best - a.best;
        return a.firstIdx - b.firstIdx;
      })
      .map(({ entry_date, count }) => ({ entry_date, count }));
  });

  const isSearching = $derived(query.trim().length > 0);
  const visibleDays = $derived(isSearching ? searchDays : browseDays);
</script>

<div class="recipe-drawer-list">
  <div class="journal-list-controls">
    <input
      type="search"
      class="sidebar-search-input"
      placeholder="Search journal"
      aria-label="Search journal"
      bind:value={query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  {#if isSearching && searchBusy}
    <!-- Replace the listing with the K.I.T.T. scanner while the
         Venice embed + Supabase round-trip are in flight. Without this
         the drawer reads as frozen between keystrokes. -->
    <div class="search-status">
      <Scanner label="Searching journal" size={0.9} />
    </div>
  {:else if isSearching && searchError}
    <p class="error" style="padding:0.75rem">
      Search failed: {searchError}
    </p>
  {:else if !isSearching && journal.loading && !journal.loaded}
    <div class="search-status">
      <Scanner label="Loading journal" size={0.9} />
    </div>
  {:else if !isSearching && journal.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load journal: {journal.error}
    </p>
  {:else if visibleDays.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {#if isSearching}
        No matches.
      {:else if journal.entries.length === 0}
        No journal entries yet. Use the panel to add one.
      {:else}
        No matches.
      {/if}
    </p>
  {:else}
    {#each visibleDays as day (day.entry_date)}
      <div class="row thread-row" data-journal-day={day.entry_date}>
        <button
          class="thread grow"
          class:active={route.journal_date === day.entry_date}
          aria-current={route.journal_date === day.entry_date ? 'true' : undefined}
          onclick={() => {
            navigate({ journal_date: day.entry_date });
            onSelect?.();
          }}
          title={`${day.entry_date} (${day.count} ${day.count === 1 ? 'entry' : 'entries'})`}
        >
          <span>{day.entry_date}</span>
          <span class="subtle" style="margin-left:0.4rem;font-size:0.75rem">
            {day.count === 1 ? '1 entry' : `${day.count} entries`}
          </span>
        </button>
      </div>
    {/each}
  {/if}
</div>

<style>
  /* Mirrors `.recipe-list-controls` / `.memory-list-controls` so the
     search row reads as the same visual element across the drawer
     tabs. The bottom border IS the divider between the search row
     and the listing rows below. */
  .journal-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    /* Space below the divider so the first journal row doesn't crowd
       the search input. Mirrors the chats / recipes / memories tabs. */
    margin-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .journal-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
</style>
