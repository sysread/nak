<script lang="ts">
  /*
   * Journal modal. The human-facing surface for the journal
   * feature - see docs/dev/journal.md for the end-to-end data flow.
   *
   * Two views, switched via `route.journal_date`:
   *
   *   (no journal_date) List view. Every entry, grouped by date,
   *                        newest first. Debounced semantic + ILIKE
   *                        search via the same pipeline the
   *                        `journal_search` tool uses. Each date
   *                        header is a button that navigates into
   *                        the day view.
   *
   *   journal_date=YYYY-MM-DD Daily view. Two stacked cards for
   *                              that date - Automatic (read-only,
   *                              deleteable; delete also excludes the
   *                              source thread ids from regeneration)
   *                              then User Entry (editable, or an
   *                              inline compose form when absent).
   *                              Prev/Next day nav, Today button.
   *
   * Chrome mirrors Memories.svelte - single scrolling column on top of
   * a shared backdrop. CSS classes are parallel (`.journal-shell`
   * etc.) so the two modals stay visually lockstep without sharing
   * styles.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    journal,
    loadJournalEntries,
    saveUserEntry,
    updateUserEntry,
    deleteEntry,
  } from '$lib/journal-store.svelte';
  import {
    downloadEntryMarkdown,
    downloadFullArchive,
  } from '$lib/journal-export';
  import { todayInZone } from '$lib/journal-day';
  import { onJournalChange } from '$lib/journal-events';
  import {
    VENICE_EMBEDDING_MODEL,
    padEmbeddingForStorage,
  } from '$lib/models';
  import Markdown from '../components/Markdown.svelte';
  import type { JournalEntry } from '$lib/supabase';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  // Cap parallels MAX_JOURNAL_CONTENT_CHARS in src/lib/tools/journal_upsert.ts
  // - a user entry and an agent entry live in the same column, so they
  // should respect the same ceiling.
  const MAX_ENTRY_CHARS = 16000;
  const MAX_MOOD_CHARS = 80;
  const MAX_TOPIC_CHARS = 60;
  const MAX_PERSON_CHARS = 60;
  const SEARCH_DEBOUNCE_MS = 200;

  const today = $derived(todayInZone(app.journalTimezone || null));
  const focusedDate = $derived(route.journal_date);

  let query = $state('');
  let searching = $state(false);
  let searchResults = $state<JournalEntry[] | null>(null);
  let searchError = $state<string | null>(null);
  let currentSearchAbort: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let archiveBusy = $state(false);
  let archiveError = $state<string | null>(null);

  let deleteTargetId = $state<string | null>(null);
  let deleteError = $state<string | null>(null);

  // User-entry compose / edit state. Only one day can be edited at a
  // time - the daily view renders a single user card anyway.
  type ComposeMode = 'none' | 'create' | 'edit';
  let composeMode = $state<ComposeMode>('none');
  let composeContent = $state('');
  let composeTopics = $state('');
  let composeMood = $state('');
  let composePeople = $state('');
  let composeBusy = $state(false);
  let composeError = $state<string | null>(null);

  // Initial load + refetch on JOURNAL_CHANGE_EVENT (fires on tool-path
  // writes too, so the modal stays in sync without a manual refresh).
  $effect(() => {
    if (!app.supabase) return;
    void loadJournalEntries(app.supabase, { limit: 500 });
    const off = onJournalChange(() => {
      if (!app.supabase) return;
      void loadJournalEntries(app.supabase, { limit: 500 });
    });
    return () => off();
  });

  // Debounced semantic search. Clears when the query is empty so the
  // list view falls back to the full `journal.entries` store.
  $effect(() => {
    const q = query.trim();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (q.length === 0) {
      searchResults = null;
      searching = false;
      searchError = null;
      if (currentSearchAbort) {
        currentSearchAbort.abort();
        currentSearchAbort = null;
      }
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  async function runSearch(q: string): Promise<void> {
    if (!app.supabase) return;
    if (currentSearchAbort) currentSearchAbort.abort();
    const ctl = new AbortController();
    currentSearchAbort = ctl;
    searching = true;
    searchError = null;
    try {
      // Best-effort Venice embed; search falls back to ILIKE when this
      // fails or the account has no API key configured.
      let embedding: number[] | null = null;
      if (app.venice) {
        try {
          const resp = await app.venice.embed({
            model: VENICE_EMBEDDING_MODEL,
            input: q,
            signal: ctl.signal,
          });
          const raw = resp.data[0]?.embedding ?? null;
          embedding = raw ? padEmbeddingForStorage(raw) : null;
        } catch {
          embedding = null;
        }
      }
      if (ctl.signal.aborted) return;
      const hits = await app.supabase.searchJournalEntries({
        query: q,
        queryEmbedding: embedding,
        limit: 50,
      });
      if (ctl.signal.aborted) return;
      searchResults = hits;
    } catch (err) {
      if (ctl.signal.aborted) return;
      searchError = err instanceof Error ? err.message : String(err);
    } finally {
      if (currentSearchAbort === ctl) currentSearchAbort = null;
      if (!ctl.signal.aborted) searching = false;
    }
  }

  // Group entries by date for the list view. Preserves the store's
  // newest-first ordering.
  const listRows = $derived.by(() => {
    const rows = searchResults ?? journal.entries;
    const byDate = new Map<string, JournalEntry[]>();
    for (const e of rows) {
      const bucket = byDate.get(e.entry_date);
      if (bucket) bucket.push(e);
      else byDate.set(e.entry_date, [e]);
    }
    return Array.from(byDate.entries());
  });

  // Active day's entries. Picks from the store, not the search
  // results, so the daily view is always authoritative.
  const dayEntries = $derived.by(() => {
    if (focusedDate === null) return [];
    return journal.entries.filter((e) => e.entry_date === focusedDate);
  });

  const dayAutomatic = $derived(
    dayEntries.find((e) => e.source === 'automatic') ?? null
  );
  const dayUser = $derived(
    dayEntries.find((e) => e.source === 'user') ?? null
  );

  function goToDay(date: string): void {
    navigate({ journal_date: date });
  }

  function backToList(): void {
    cancelCompose();
    navigate({ journal_date: null });
  }

  // Add/subtract one calendar day to the YYYY-MM-DD key. Uses UTC math
  // on purpose - we're shifting an already-bucketed date key, not
  // translating a wall-clock moment, so zone-agnostic stepping is
  // correct.
  function shiftDay(ymd: string, delta: number): string {
    const [y, m, d] = ymd.split('-').map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      return ymd;
    }
    const utc = new Date(Date.UTC(y, m - 1, d));
    utc.setUTCDate(utc.getUTCDate() + delta);
    const yy = utc.getUTCFullYear();
    const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(utc.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  function startCompose(entry: JournalEntry | null): void {
    if (entry) {
      composeMode = 'edit';
      composeContent = entry.content;
      composeTopics = entry.topics.join(', ');
      composeMood = entry.mood ?? '';
      composePeople = entry.people.join(', ');
    } else {
      composeMode = 'create';
      composeContent = '';
      composeTopics = '';
      composeMood = '';
      composePeople = '';
    }
    composeBusy = false;
    composeError = null;
  }

  function cancelCompose(): void {
    if (composeBusy) return;
    composeMode = 'none';
    composeContent = '';
    composeTopics = '';
    composeMood = '';
    composePeople = '';
    composeError = null;
  }

  // Parse a comma-separated chip input. Dedup + trim + drop empties so
  // "tired, , exhausted" doesn't land three entries in topics[].
  function parseChips(raw: string, maxLen: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const piece of raw.split(',')) {
      const t = piece.trim();
      if (t.length === 0) continue;
      if (t.length > maxLen) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  async function saveCompose(): Promise<void> {
    if (!app.supabase || focusedDate === null) return;
    const content = composeContent.trim();
    if (content.length === 0) {
      composeError = 'Write something first.';
      return;
    }
    if (content.length > MAX_ENTRY_CHARS) {
      composeError = `Entry must be ${MAX_ENTRY_CHARS} chars or fewer.`;
      return;
    }
    const mood = composeMood.trim().slice(0, MAX_MOOD_CHARS);
    const topics = parseChips(composeTopics, MAX_TOPIC_CHARS);
    const people = parseChips(composePeople, MAX_PERSON_CHARS);
    composeBusy = true;
    composeError = null;
    try {
      if (composeMode === 'edit' && dayUser) {
        await updateUserEntry(app.supabase, dayUser.id, {
          content,
          topics,
          mood: mood.length > 0 ? mood : null,
          people,
        });
      } else {
        await saveUserEntry(app.supabase, {
          entryDate: focusedDate,
          content,
          topics,
          mood: mood.length > 0 ? mood : null,
          people,
        });
      }
      composeMode = 'none';
      composeContent = '';
      composeTopics = '';
      composeMood = '';
      composePeople = '';
    } catch (err) {
      composeError = err instanceof Error ? err.message : String(err);
    } finally {
      composeBusy = false;
    }
  }

  function requestDelete(id: string): void {
    deleteTargetId = id;
    deleteError = null;
  }

  function cancelDelete(): void {
    deleteTargetId = null;
    deleteError = null;
  }

  async function confirmDelete(): Promise<void> {
    if (!app.supabase || !deleteTargetId) return;
    const id = deleteTargetId;
    try {
      await deleteEntry(app.supabase, id);
      deleteTargetId = null;
      deleteError = null;
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onExportArchive(): Promise<void> {
    if (!app.supabase) return;
    archiveBusy = true;
    archiveError = null;
    try {
      await downloadFullArchive(app.supabase);
    } catch (err) {
      archiveError = err instanceof Error ? err.message : String(err);
    } finally {
      archiveBusy = false;
    }
  }

  // Format YYYY-MM-DD as a human-friendly day-of-week + date. Built on
  // Intl.DateTimeFormat rather than a library so the bundle stays
  // lean. Uses UTC interpretation because the key is already a
  // zone-agnostic day bucket; letting the local zone nudge it would
  // flip the label for dates straddling midnight.
  function formatDateLong(ymd: string): string {
    const [y, m, d] = ymd.split('-').map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(y)) return ymd;
    const dt = new Date(Date.UTC(y, m - 1, d));
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      }).format(dt);
    } catch {
      return ymd;
    }
  }

  function entryTags(entry: JournalEntry): string[] {
    const chips: string[] = [];
    if (entry.mood) chips.push(`mood: ${entry.mood}`);
    for (const t of entry.topics) chips.push(t);
    return chips;
  }
</script>

<!--
  Escape and click-outside both dismiss. The outer `.center` is the
  backdrop — only close when the target IS the backdrop so clicks
  inside `.journal-shell` don't spuriously close. Same pattern
  as Memories / Settings / Help.
-->
<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center journal-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div
    class="journal-shell"
    role="dialog"
    aria-modal="true"
    aria-label="Journal"
  >
    <button
      type="button"
      class="journal-close"
      onclick={onClose}
      aria-label="Close journal"
      title="Close"
    >×</button>

    <header class="journal-header">
      {#if focusedDate === null}
        <h1 class="journal-title">Journal</h1>
        <p class="subtle journal-blurb">
          A daily journal the assistant keeps alongside you. Automatic
          entries draw from your conversations; your own entries sit
          next to them. Delete anything you'd rather not keep - an
          automatic entry you delete won't be regenerated from the
          same conversation.
        </p>
        <div class="journal-controls">
          <input
            type="search"
            placeholder="Search journal…"
            bind:value={query}
            autocomplete="off"
            spellcheck="false"
            aria-label="Search journal"
          />
          <button
            type="button"
            onclick={() => goToDay(today)}
            title="Jump to today's entry"
          >Today</button>
          <button
            type="button"
            class="secondary"
            onclick={onExportArchive}
            disabled={archiveBusy || journal.entries.length === 0}
            title="Download every entry as a ZIP of Markdown files"
          >{archiveBusy ? 'Preparing…' : 'Export all (.zip)'}</button>
        </div>
        {#if archiveError}<p class="error">{archiveError}</p>{/if}
      {:else}
        <div class="journal-daynav">
          <button
            type="button"
            class="secondary"
            onclick={backToList}
            aria-label="Back to list"
            title="Back to list"
          >← All entries</button>
          <button
            type="button"
            class="secondary"
            onclick={() => goToDay(shiftDay(focusedDate, -1))}
            aria-label="Previous day"
            title="Previous day"
          >‹</button>
          <h1 class="journal-title daily-title">{formatDateLong(focusedDate)}</h1>
          <button
            type="button"
            class="secondary"
            onclick={() => goToDay(shiftDay(focusedDate, 1))}
            aria-label="Next day"
            title="Next day"
            disabled={focusedDate >= today}
          >›</button>
          {#if focusedDate !== today}
            <button
              type="button"
              class="secondary"
              onclick={() => goToDay(today)}
              title="Jump to today's entry"
            >Today</button>
          {/if}
        </div>
      {/if}
    </header>

    <section class="journal-body">
      {#if journal.error}<p class="error">{journal.error}</p>{/if}
      {#if searchError}<p class="error">{searchError}</p>{/if}

      {#if focusedDate === null}
        <!-- ----------- List view ----------- -->
        {#if searching && listRows.length === 0}
          <p class="subtle">Searching…</p>
        {:else if journal.loading && !journal.loaded}
          <p class="subtle">Loading journal…</p>
        {:else if journal.error}
          <p class="error">Couldn't load journal: {journal.error}</p>
        {:else if listRows.length === 0}
          {#if query.trim().length > 0}
            <p class="subtle journal-empty">
              No matches for "{query.trim()}".
            </p>
          {:else}
            <p class="subtle journal-empty">
              Nothing here yet. Start a conversation; the automatic
              journaler writes itself a page once the conversation
              settles, or use the Today button above to write one
              yourself.
            </p>
          {/if}
        {:else}
          <ul class="journal-list">
            {#each listRows as [date, entries] (date)}
              <li class="journal-day">
                <button
                  type="button"
                  class="day-header"
                  onclick={() => goToDay(date)}
                  title="Open this day"
                >
                  <span class="day-header-date">{formatDateLong(date)}</span>
                  <span class="subtle day-header-meta">
                    {entries.length === 1 ? '1 entry' : `${entries.length} entries`}
                  </span>
                </button>
                <ul class="journal-day-entries">
                  {#each entries as entry (entry.id)}
                    <li class="journal-preview">
                      <span
                        class="journal-badge badge-{entry.source}"
                        title={entry.source === 'automatic' ? 'Written by the journaler' : 'Your own entry'}
                      >{entry.source === 'automatic' ? 'Automatic' : 'You'}</span>
                      <p class="journal-preview-text">{entry.content}</p>
                      {#if entryTags(entry).length > 0}
                        <div class="journal-chips">
                          {#each entryTags(entry) as chip}
                            <span class="chip">{chip}</span>
                          {/each}
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <!-- ----------- Daily view ----------- -->
        {#if dayAutomatic}
          <article class="journal-card card-automatic">
            <header class="journal-card-header">
              <span class="journal-badge badge-automatic">Automatic</span>
              {#if dayAutomatic.mood}
                <span class="chip">mood: {dayAutomatic.mood}</span>
              {/if}
              {#each dayAutomatic.topics as t}
                <span class="chip">{t}</span>
              {/each}
            </header>
            <div class="journal-card-body">
              <Markdown content={dayAutomatic.content} />
            </div>
            {#if dayAutomatic.people.length > 0}
              <p class="subtle journal-people">
                People: {dayAutomatic.people.join(', ')}
              </p>
            {/if}
            <footer class="journal-card-actions">
              <button
                type="button"
                class="secondary"
                onclick={() => downloadEntryMarkdown(dayAutomatic!)}
                title="Download this entry as Markdown"
              >Export .md</button>
              {#if deleteTargetId === dayAutomatic.id}
                <span class="subtle journal-delete-prompt">
                  Delete and stop journaling these conversations?
                </span>
                <button
                  type="button"
                  class="secondary"
                  onclick={cancelDelete}
                >Cancel</button>
                <button
                  type="button"
                  class="danger"
                  onclick={confirmDelete}
                >Delete</button>
              {:else}
                <button
                  type="button"
                  class="secondary"
                  onclick={() => requestDelete(dayAutomatic!.id)}
                >Delete</button>
              {/if}
            </footer>
            {#if deleteTargetId === dayAutomatic.id && deleteError}
              <p class="error">{deleteError}</p>
            {/if}
          </article>
        {/if}

        {#if composeMode === 'none'}
          {#if dayUser}
            <article class="journal-card card-user">
              <header class="journal-card-header">
                <span class="journal-badge badge-user">You</span>
                {#if dayUser.mood}
                  <span class="chip">mood: {dayUser.mood}</span>
                {/if}
                {#each dayUser.topics as t}
                  <span class="chip">{t}</span>
                {/each}
              </header>
              <div class="journal-card-body">
                <Markdown content={dayUser.content} />
              </div>
              {#if dayUser.people.length > 0}
                <p class="subtle journal-people">
                  People: {dayUser.people.join(', ')}
                </p>
              {/if}
              <footer class="journal-card-actions">
                <button
                  type="button"
                  class="secondary"
                  onclick={() => startCompose(dayUser)}
                >Edit</button>
                <button
                  type="button"
                  class="secondary"
                  onclick={() => downloadEntryMarkdown(dayUser!)}
                  title="Download this entry as Markdown"
                >Export .md</button>
                {#if deleteTargetId === dayUser.id}
                  <span class="subtle journal-delete-prompt">Really delete?</span>
                  <button
                    type="button"
                    class="secondary"
                    onclick={cancelDelete}
                  >Cancel</button>
                  <button
                    type="button"
                    class="danger"
                    onclick={confirmDelete}
                  >Delete</button>
                {:else}
                  <button
                    type="button"
                    class="secondary"
                    onclick={() => requestDelete(dayUser!.id)}
                  >Delete</button>
                {/if}
              </footer>
              {#if deleteTargetId === dayUser.id && deleteError}
                <p class="error">{deleteError}</p>
              {/if}
            </article>
          {:else}
            <div class="journal-empty-day">
              <p class="subtle">
                No user entry for this day yet.
              </p>
              <button
                type="button"
                onclick={() => startCompose(null)}
              >Write an entry</button>
            </div>
          {/if}
        {:else}
          <article class="journal-card card-user card-compose">
            <header class="journal-card-header">
              <span class="journal-badge badge-user">You</span>
              <span class="subtle">
                {composeMode === 'edit' ? 'Editing your entry' : 'New entry'}
              </span>
            </header>
            <div class="compose-form">
              <div class="form-row">
                <label for="compose-content">What's on your mind?</label>
                <textarea
                  id="compose-content"
                  class="compose-textarea"
                  maxlength={MAX_ENTRY_CHARS}
                  bind:value={composeContent}
                  placeholder="Markdown supported."
                ></textarea>
                <span class="subtle char-count">
                  {composeContent.length}/{MAX_ENTRY_CHARS}
                </span>
              </div>
              <div class="form-row">
                <label for="compose-mood">Mood (optional)</label>
                <input
                  id="compose-mood"
                  type="text"
                  maxlength={MAX_MOOD_CHARS}
                  bind:value={composeMood}
                  placeholder="e.g. tired / hopeful"
                />
              </div>
              <div class="form-row">
                <label for="compose-topics">Topics (optional, comma-separated)</label>
                <input
                  id="compose-topics"
                  type="text"
                  bind:value={composeTopics}
                  placeholder="e.g. work, sleep, therapy"
                />
              </div>
              <div class="form-row">
                <label for="compose-people">People (optional, comma-separated)</label>
                <input
                  id="compose-people"
                  type="text"
                  bind:value={composePeople}
                  placeholder="first names or labels"
                />
              </div>
              {#if composeError}
                <p class="error">{composeError}</p>
              {/if}
              <div class="compose-actions">
                <button
                  type="button"
                  class="secondary"
                  onclick={cancelCompose}
                  disabled={composeBusy}
                >Cancel</button>
                <button
                  type="button"
                  onclick={saveCompose}
                  disabled={composeBusy || composeContent.trim().length === 0}
                >{composeBusy ? 'Saving…' : composeMode === 'edit' ? 'Save changes' : 'Save entry'}</button>
              </div>
            </div>
          </article>
        {/if}

        {#if !dayAutomatic && !dayUser && composeMode === 'none'}
          <p class="subtle">
            Nothing saved for this day. Use <em>Write an entry</em> above
            to start one, or keep chatting - the automatic journaler
            will fill in a page once it has something worth writing.
          </p>
        {/if}
      {/if}
    </section>
  </div>
</div>

<style>
  /* Parallel to .memories-shell / .help-shell / .settings-shell. */
  .journal-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 52rem;
    display: grid;
    grid-template-rows: auto 1fr;
    height: min(44rem, 88vh);
    overflow: hidden;
  }

  .journal-close {
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

  .journal-close:hover {
    background: var(--bg-2);
  }

  .journal-header {
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    padding-right: 3rem;
  }

  .journal-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
  }

  .daily-title {
    flex: 1;
    text-align: center;
    margin: 0;
  }

  .journal-blurb {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
  }

  .journal-controls {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .journal-controls input[type='search'] {
    flex: 1;
    min-width: 10rem;
    padding: 0.45rem 0.6rem;
    font-size: 0.9rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .journal-daynav {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .journal-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    min-width: 0;
  }

  .journal-empty {
    margin: 1rem 0;
  }

  .journal-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .journal-day {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .day-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font: inherit;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }

  .day-header:hover {
    background: var(--surface);
  }

  .day-header-date {
    font-weight: 600;
  }

  .day-header-meta {
    font-size: 0.8rem;
  }

  .journal-day-entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .journal-preview {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .journal-preview-text {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text);
    /* Keep previews scannable - a long automatic entry would otherwise
       dwarf every other day. Clamp to three lines. */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .journal-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.75rem 0.9rem;
    margin-bottom: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .card-automatic {
    background: var(--bg-2);
  }

  .journal-card-header {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .journal-card-body {
    font-size: 0.95rem;
    color: var(--text);
  }

  .journal-card-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .journal-people {
    margin: 0;
    font-size: 0.8rem;
  }

  .journal-delete-prompt {
    font-size: 0.85rem;
    margin-right: 0.25rem;
  }

  .journal-badge {
    display: inline-block;
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    line-height: 1;
    font-weight: 500;
    text-transform: lowercase;
    flex: 0 0 auto;
  }

  .badge-automatic {
    background: var(--bg-2);
    color: var(--muted);
  }

  .badge-user {
    background: var(--accent-bg, var(--bg-2));
    color: var(--accent, var(--text));
    border-color: var(--accent, var(--border));
  }

  .journal-chips,
  .journal-card-header {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .chip {
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-2);
    color: var(--muted);
    line-height: 1;
    white-space: nowrap;
  }

  .journal-empty-day {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .compose-form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .compose-form .form-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .compose-form label {
    font-size: 0.8rem;
    color: var(--muted);
  }

  .compose-form input,
  .compose-form textarea {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.55rem;
    font: inherit;
    width: 100%;
  }

  .compose-textarea {
    min-height: 10rem;
    resize: vertical;
    font-family: inherit;
  }

  .char-count {
    font-size: 0.75rem;
    align-self: flex-end;
  }

  .compose-actions {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
</style>
