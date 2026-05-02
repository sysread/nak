<script lang="ts">
  /*
   * Sidebar journal listing. Shown in the left drawer when the Journal
   * tab is active. One row per date - multiple entries on the same day
   * all open the same day-view, so collapsing to a date index is the
   * right granularity for a browse surface.
   *
   * Clicking a date calls navigate({ journal_date: 'YYYY-MM-DD' }), which
   * switches the main panel to JournalPanel showing that day's entries.
   */
  import { navigate } from '$lib/routing.svelte';
  import { journal } from '$lib/journal-store.svelte';

  // Parent (Chat shell) passes a callback that dismisses the mobile
  // drawer once the main panel has navigated to the chosen day.
  // Optional so the component is still usable in contexts that don't
  // own a drawer.
  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  let query = $state('');

  // Filters entries by content / topics / mood substring match, then
  // aggregates to one row per entry_date. journal.entries is sorted
  // newest-day-first; preserve that order via insertion-ordered Map.
  const visibleJournal = $derived.by<
    { entry_date: string; count: number; matchId: string }[]
  >(() => {
    const q = query.trim().toLowerCase();
    const matches = q.length === 0
      ? journal.entries
      : journal.entries.filter((e) => {
          if (e.content.toLowerCase().includes(q)) return true;
          if (e.mood && e.mood.toLowerCase().includes(q)) return true;
          for (const t of e.topics) {
            if (t.toLowerCase().includes(q)) return true;
          }
          return false;
        });
    const byDay = new Map<string, { count: number; matchId: string }>();
    for (const e of matches) {
      const cur = byDay.get(e.entry_date);
      if (cur) cur.count += 1;
      else byDay.set(e.entry_date, { count: 1, matchId: e.id });
    }
    return Array.from(byDay, ([entry_date, v]) => ({
      entry_date,
      count: v.count,
      matchId: v.matchId,
    }));
  });
</script>

<div class="recipe-drawer-list">
  <input
    type="search"
    class="sidebar-search-input journal-list-search"
    placeholder="Search journal"
    aria-label="Search journal"
    bind:value={query}
  />
  {#if journal.loading && !journal.loaded}
    <p class="subtle" style="padding:0.75rem">Loading journal…</p>
  {:else if journal.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load journal: {journal.error}
    </p>
  {:else if visibleJournal.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {#if journal.entries.length === 0}
        No journal entries yet. Use the panel to add one.
      {:else}
        No matches.
      {/if}
    </p>
  {:else}
    {#each visibleJournal as day (day.entry_date)}
      <div class="row thread-row" data-journal-day={day.entry_date}>
        <button
          class="thread grow"
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
  .journal-list-search {
    display: block;
    margin: 0.4rem 0.6rem;
    width: calc(100% - 1.2rem);
  }
</style>
