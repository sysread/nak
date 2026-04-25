<script lang="ts">
  /*
   * Journal modal. Daily-view-only surface - the drawer's day index
   * is the equivalent of a list view, so the modal itself just shows
   * one day at a time and lets the user step day-by-day from there.
   *
   * route.journal_date carries the focused day. When absent (the
   * drawer footer's "Open journal" button passes nothing) the modal
   * defaults to today via the local-timezone helper. Closing the
   * modal returns the user to whatever drawer tab they came from -
   * there is no in-modal back-to-list affordance because there is
   * no list to go back to.
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
    markEntryHam,
  } from '$lib/journal-store.svelte';
  import { downloadEntryMarkdown } from '$lib/journal-export';
  import { todayInZone } from '$lib/journal-day';
  import { onJournalChange } from '$lib/journal-events';
  import Markdown from '../components/Markdown.svelte';
  import type { JournalEntry } from '$lib/supabase';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  // Cap parallels MAX_JOURNAL_CONTENT_CHARS in
  // src/lib/agents/journal/types.ts - a user entry and an agent entry
  // live in the same column, so they should respect the same ceiling.
  const MAX_ENTRY_CHARS = 16000;
  const MAX_MOOD_CHARS = 80;
  const MAX_TOPIC_CHARS = 60;
  const MAX_PERSON_CHARS = 60;

  const today = $derived(todayInZone(app.journalTimezone || null));
  // Default to today when the route doesn't specify a date - the
  // drawer's "Open journal" footer button intentionally passes no
  // journal_date so the modal lands on the user's most-current day.
  const focusedDate = $derived(route.journal_date ?? today);

  let deleteTargetId = $state<string | null>(null);
  let deleteError = $state<string | null>(null);

  // Ham-button state. One-shot per entry; the spam-filter training is
  // best-effort downstream so we mostly need to track which row's
  // request is in flight (to avoid a double-click sending two RPCs)
  // and surface errors inline. Idempotency is enforced server-side
  // via the WHERE-is-null clause on the update; the UI just hides
  // the button once entry.ham_marked_at flips non-null.
  let hamBusyId = $state<string | null>(null);
  let hamError = $state<string | null>(null);
  let hamErrorId = $state<string | null>(null);

  // User-entry compose / edit state. Only one day can be edited at a
  // time - the daily view renders a single user card anyway.
  type ComposeMode = 'none' | 'create' | 'edit';
  let composeMode = $state<ComposeMode>('none');
  // Set on Edit-an-existing-user-entry; the entry being edited is
  // hidden from the list and the compose form takes its slot. Stays
  // null when composeMode is 'create' or 'none'.
  let composeEditId = $state<string | null>(null);
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
  // Active day's entries. Picks from the store as the source of truth.
  //
  // Order: user entries first (oldest-created first), then automatic
  // entries in conversation-start order (oldest thread first). The
  // user-first ordering is intentional - the human's own framing of
  // the day reads more naturally before the agent's third-person
  // observational paragraphs. Within each section we sort
  // chronologically so reading top-to-bottom matches how the day
  // unfolded.
  const dayEntriesOrdered = $derived.by<JournalEntry[]>(() => {
    const all = journal.entries.filter((e) => e.entry_date === focusedDate);
    const users = all
      .filter((e) => e.source === 'user')
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    const autos = all
      .filter((e) => e.source === 'automatic')
      .sort((a, b) => {
        // Sort by source-conversation start time when available;
        // fall back to entry created_at when the embed is missing
        // (semantic-search RPC, deleted thread). Never zero-tie
        // entries from different threads since equal created_at on
        // distinct rows is vanishingly unlikely and sort stability
        // covers the rare collision.
        const aKey = a.thread_created_at ?? a.created_at;
        const bKey = b.thread_created_at ?? b.created_at;
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      });
    return [...users, ...autos];
  });

  /**
   * Strip newlines and collapse whitespace, then truncate to
   * `maxChars` (with an ellipsis when clipped). The auto-titler now
   * sanitises titles up front so this is mostly defensive, but the
   * journaler's daily view shows multiple titles stacked on a single
   * column so a stray multi-line title would otherwise blow out the
   * vertical rhythm. Returns 'Untitled conversation' when title is
   * null - the source thread was deleted (FK on delete set null).
   */
  function formatTitle(title: string | null, maxChars = 60): string {
    if (!title) return 'Untitled conversation';
    const collapsed = title.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) return 'Untitled conversation';
    if (collapsed.length <= maxChars) return collapsed;
    return collapsed.slice(0, maxChars - 1).trimEnd() + '…';
  }

  function openConversation(threadId: string | null): void {
    if (!threadId) return;
    navigate({ cid: threadId, modal: null, journal_date: null });
  }

  function goToDay(date: string): void {
    navigate({ journal_date: date });
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
      composeEditId = entry.id;
      composeContent = entry.content;
      composeTopics = entry.topics.join(', ');
      composeMood = entry.mood ?? '';
      composePeople = entry.people.join(', ');
    } else {
      composeMode = 'create';
      composeEditId = null;
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
    composeEditId = null;
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
    if (!app.supabase) return;
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
      if (composeMode === 'edit' && composeEditId) {
        await updateUserEntry(app.supabase, composeEditId, {
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
      composeEditId = null;
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

  // Ham click handler. Hits the markEntryHam helper which sets
  // ham_marked_at and trains the source thread's tokens as ham. The
  // helper returns null when the row was already marked - we treat
  // that as success (the user clicked it on a stale tab; the
  // server-side guard prevented the double-train) so the button
  // just disappears.
  async function onMarkHam(id: string): Promise<void> {
    if (!app.supabase || hamBusyId !== null) return;
    hamBusyId = id;
    hamError = null;
    hamErrorId = null;
    try {
      await markEntryHam(app.supabase, id);
    } catch (err) {
      hamError = err instanceof Error ? err.message : String(err);
      hamErrorId = id;
    } finally {
      hamBusyId = null;
    }
  }

  // Compact ISO-flavoured form ("SUN 2026-04-19") for the daily-view
  // title. Short weekday + ISO date keeps the title to a single line
  // on any reasonable phone width and matches the daynav button row.
  // Uses UTC interpretation because the key is already a zone-agnostic
  // day bucket; letting the local zone nudge it would flip the label
  // for dates straddling midnight.
  function formatDateCompact(ymd: string): string {
    const [y, m, d] = ymd.split('-').map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(y)) return ymd;
    const dt = new Date(Date.UTC(y, m - 1, d));
    try {
      const weekday = new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        timeZone: 'UTC',
      }).format(dt);
      return `${weekday.toUpperCase()} ${ymd}`;
    } catch {
      return ymd;
    }
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
      <div class="journal-daynav">
        <button
          type="button"
          class="secondary"
          onclick={() => goToDay(shiftDay(focusedDate, -1))}
          aria-label="Previous day"
          title="Previous day"
        >‹</button>
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
      <h1 class="journal-title daily-title">{formatDateCompact(focusedDate)}</h1>
    </header>

    <section class="journal-body">
      {#if journal.error}<p class="error">{journal.error}</p>{/if}
      <!--
          Compound day view. The dayEntriesOrdered list is already
          sorted (user entries first, automatic entries by source-
          conversation-start time within their section). We render a
          curtain-rod divider between every adjacent pair so the
          column reads as one continuous day-of-the-user broken into
          recognisable sections, not a stack of disconnected cards.

          Compose mode interleaves: 'create' inserts the form at the
          top of the list (before any existing entries), 'edit' hides
          the entry being edited and inserts the form in its slot.
        -->
        {#if composeMode === 'create'}
          {@render composeForm()}
          {#if dayEntriesOrdered.length > 0}
            {@render divider()}
          {/if}
        {/if}

        {#each dayEntriesOrdered as entry, idx (entry.id)}
          {#if composeMode === 'edit' && composeEditId === entry.id}
            {@render composeForm()}
          {:else if entry.source === 'user'}
            {@render userCard(entry)}
          {:else}
            {@render automaticCard(entry)}
          {/if}
          {#if idx < dayEntriesOrdered.length - 1}
            {@render divider()}
          {/if}
        {/each}

        {#if dayEntriesOrdered.length === 0 && composeMode === 'none'}
          <p class="subtle journal-empty-day-text">
            Nothing saved for this day. Use <em>Write an entry</em> below
            to start one, or keep chatting - the automatic journaler
            will fill in a page once it has something worth writing.
          </p>
        {/if}

        <!--
          Footer "Write an entry" button. Only when no compose form is
          already on screen. Always available regardless of whether the
          day already has user entries; the schema allows multiple per
          day. The button intentionally sits below the entries so its
          presence doesn't compete visually with reading the day.
        -->
        {#if composeMode === 'none'}
        <div class="journal-write-action">
          <button
            type="button"
            onclick={() => startCompose(null)}
          >Write an entry</button>
        </div>
      {/if}
    </section>
  </div>
</div>

<!--
  Snippets for the compound day view. Pulled out as top-level
  snippets rather than inlined so the daily-view loop stays readable
  and the compose-form duplication on edit-vs-create paths reuses one
  source of truth.
-->

{#snippet divider()}
  <div class="journal-divider" role="separator" aria-hidden="true">
    <span class="journal-divider-finial">❦</span>
    <span class="journal-divider-rod"></span>
    <span class="journal-divider-finial">❦</span>
  </div>
{/snippet}

{#snippet automaticCard(entry: JournalEntry)}
  <article class="journal-card card-automatic">
    <header class="journal-card-conversation-title">
      {#if entry.thread_id}
        <button
          type="button"
          class="journal-thread-link"
          title={entry.thread_title ?? 'Open this conversation'}
          onclick={() => openConversation(entry.thread_id)}
        >{formatTitle(entry.thread_title)}</button>
      {:else}
        <span class="subtle journal-thread-link-disabled">
          {formatTitle(entry.thread_title)}
        </span>
      {/if}
    </header>
    {#if entry.mood || entry.topics.length > 0}
      <div class="journal-card-chips">
        {#if entry.mood}
          <span class="chip">mood: {entry.mood}</span>
        {/if}
        {#each entry.topics as t}
          <span class="chip">{t}</span>
        {/each}
      </div>
    {/if}
    <div class="journal-card-body">
      <Markdown content={entry.content} />
    </div>
    {#if entry.people.length > 0}
      <p class="subtle journal-people">
        People: {entry.people.join(', ')}
      </p>
    {/if}
    <footer class="journal-card-actions">
      <button
        type="button"
        class="secondary"
        onclick={() => downloadEntryMarkdown(entry)}
        title="Download this entry as Markdown"
      >Export .md</button>
      <!--
        Ham button - the user's "this entry was appropriate" signal.
        Appears only on automatic entries that still have a source
        thread (orphans can't be trained against) and that haven't
        already been marked. Once clicked, the column flips and the
        button disappears, replaced by a quiet "Marked good" tag so
        the user can see the action took. The thumbs-up icon plus
        the explicit text matches the verb-first pattern of the
        other footer buttons.
      -->
      <!--
        Spam-filter votes. Thumbs-up trains the source conversation's
        tokens as ham; thumbs-down (Delete) trains them as spam AND
        deletes the entry + adds the thread to journal_thread_excludes.
        Emoji-only labels keep the row compact alongside Export .md;
        aria-label + title carry the verb for screen readers and
        hover tooltips. The Marked-good tag replaces the thumbs-up
        once clicked so the action is durable across reloads.
      -->
      {#if entry.ham_marked_at !== null}
        <span class="subtle journal-ham-marked" title="You marked this entry as appropriate. Trained the spam filter on the source conversation.">Marked good</span>
      {:else if entry.thread_id}
        <button
          type="button"
          class="secondary journal-vote-btn"
          aria-label="Looks good"
          onclick={() => onMarkHam(entry.id)}
          disabled={hamBusyId === entry.id}
          title="Looks good - tell the spam filter this kind of conversation IS journal-worthy"
        >{hamBusyId === entry.id ? '…' : '👍'}</button>
      {/if}
      {#if deleteTargetId === entry.id}
        <span class="subtle journal-delete-prompt">
          Delete and stop journaling this conversation?
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
          class="secondary journal-vote-btn"
          aria-label="Delete and mark as spam"
          onclick={() => requestDelete(entry.id)}
          title="Delete - tell the spam filter this kind of conversation is NOT journal-worthy"
        >👎</button>
      {/if}
    </footer>
    {#if deleteTargetId === entry.id && deleteError}
      <p class="error">{deleteError}</p>
    {/if}
    {#if hamErrorId === entry.id && hamError}
      <p class="error">{hamError}</p>
    {/if}
  </article>
{/snippet}

{#snippet userCard(entry: JournalEntry)}
  <article class="journal-card card-user">
    {#if entry.mood || entry.topics.length > 0}
      <div class="journal-card-chips">
        <span class="journal-badge badge-user">You</span>
        {#if entry.mood}
          <span class="chip">mood: {entry.mood}</span>
        {/if}
        {#each entry.topics as t}
          <span class="chip">{t}</span>
        {/each}
      </div>
    {:else}
      <div class="journal-card-chips">
        <span class="journal-badge badge-user">You</span>
      </div>
    {/if}
    <div class="journal-card-body">
      <Markdown content={entry.content} />
    </div>
    {#if entry.people.length > 0}
      <p class="subtle journal-people">
        People: {entry.people.join(', ')}
      </p>
    {/if}
    <footer class="journal-card-actions">
      <button
        type="button"
        class="secondary"
        onclick={() => startCompose(entry)}
      >Edit</button>
      <button
        type="button"
        class="secondary"
        onclick={() => downloadEntryMarkdown(entry)}
        title="Download this entry as Markdown"
      >Export .md</button>
      {#if deleteTargetId === entry.id}
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
          onclick={() => requestDelete(entry.id)}
        >Delete</button>
      {/if}
    </footer>
    {#if deleteTargetId === entry.id && deleteError}
      <p class="error">{deleteError}</p>
    {/if}
  </article>
{/snippet}

{#snippet composeForm()}
  <article class="journal-card card-user card-compose">
    <header class="journal-card-chips">
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
{/snippet}

<style>
  /*
   * Compound day view styles. Each card sits flush in a single
   * column; the curtain-rod divider provides the visual separation
   * between adjacent entries (the cards themselves drop their bottom
   * margin so the divider's spacing is the only gap).
   */

  /*
   * Curtain-rod divider. A thin rule with floral-heart finials on
   * each end. ASCII line + Unicode finials so the look survives
   * font-rendering differences across platforms. role="separator"
   * + aria-hidden cover both the screen-reader contract (it's
   * decorative) and the semantics (it marks a section break).
   */
  .journal-divider {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 1.25rem 0.25rem;
    color: var(--muted);
    user-select: none;
  }
  .journal-divider-rod {
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .journal-divider-finial {
    font-size: 0.95rem;
    line-height: 1;
    opacity: 0.7;
  }

  /*
   * Conversation-title header on automatic entries. Centered,
   * single-line, button-styled so click semantics are obvious. The
   * disabled fallback (thread deleted) renders as plain muted text.
   */
  .journal-card-conversation-title {
    text-align: center;
    margin-bottom: 0.5rem;
  }
  .journal-thread-link,
  .journal-thread-link-disabled {
    display: inline-block;
    max-width: 100%;
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1.3;
    /* Allow long titles to wrap onto multiple lines so the full title
       stays visible. The parent .journal-card-conversation-title
       centers this inline-block; text-align: center keeps the
       wrapped lines themselves centered within the button/span (a
       <button> picks this up from the UA stylesheet anyway, the
       disabled <span> would left-align without it). */
    text-align: center;
  }
  .journal-thread-link {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--accent, var(--text));
    cursor: pointer;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.2em;
  }
  .journal-thread-link:hover {
    color: var(--text);
  }
  .journal-thread-link-disabled {
    color: var(--muted);
    font-style: italic;
  }

  /*
   * Card-chip row sits below the conversation title (auto entries) or
   * at the top of the card (user entries). Same flex-wrap as the old
   * .journal-card-header but pulled out so user / auto cards don't
   * have to share a class with subtle layout differences.
   */
  .journal-card-chips {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .journal-write-action {
    margin-top: 1.25rem;
    display: flex;
    justify-content: center;
  }

  .journal-empty-day-text {
    margin: 1rem 0;
  }

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
    /* Sits on its own row below .journal-daynav (see template). The
       ISO-flavoured compact form (formatDateCompact - "SUN 2026-04-19")
       lets the title stay a single line on a phone, and stepping the
       size down from the journal-list h1 keeps the header chrome
       visually quiet now that it spans two rows. text-align is offset
       slightly left of viewport center on mobile because the header
       carries `padding-right: 3rem` to clear the absolute-positioned
       close button in the top-right; the offset is a fraction of an em
       and reads as centered for a 14-character string. */
    text-align: center;
    margin: 0.4rem 0 0;
    font-size: 0.95rem;
    font-weight: 600;
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

  .journal-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.75rem 0.9rem;
    margin-bottom: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    /* Flex items default to min-width: auto, sized by their content's
       min-content width. A long unbreakable token in the body (URL,
       hash, em-dash run without surrounding spaces) would otherwise
       push the card past .journal-body's width and out the right edge
       of the modal - same failure mode .msg handles. Allow the card
       to shrink to its parent's width so the wrapping rules on
       .journal-card-body below can take over. */
    min-width: 0;
  }

  .card-automatic {
    background: var(--bg-2);
  }

  .journal-card-body {
    font-size: 0.95rem;
    color: var(--text);
    /* Mirror .msg's wrapping rules so the rendered markdown wraps to
       the card's width rather than running off the right edge.
       Without these, prose with em-dash compounds ("anxiety-secondary")
       or long hashes/URLs renders as a single overflowing line - the
       Markdown component itself doesn't carry these styles, it relies
       on the container. */
    overflow-wrap: anywhere;
    word-break: break-word;
    min-width: 0;
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

  /* Quiet "you marked this" tag that replaces the thumbs-up button
     once the user clicks it. Sits in the same row as the action
     buttons so the spacing matches; visually muted so it doesn't
     compete with the actual buttons. */
  .journal-ham-marked {
    font-size: 0.85rem;
    padding: 0 0.25rem;
  }

  /* Emoji-only vote buttons (thumbs-up for ham, thumbs-down for the
     delete trigger). Tighten horizontal padding compared to the
     text buttons in the same row so the glyph reads as a square
     control rather than a wide pill. The emoji itself carries the
     visual weight; aria-label + title keep the action discoverable
     for keyboard / screen-reader users. */
  .journal-vote-btn {
    padding-inline: 0.45rem;
    line-height: 1;
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

  .badge-user {
    background: var(--accent-bg, var(--bg-2));
    color: var(--accent, var(--text));
    border-color: var(--accent, var(--border));
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

  /*
   * Small-screen inner padding. The shared `.center`-modal full-bleed
   * rules (styles.css, bottom) take the shell edge-to-edge on mobile;
   * here we tighten the journal's own header / body / card paddings so
   * the gained width reaches the entry text rather than feeding a
   * widened inner gutter.
   */
  @media (max-width: 720px) {
    .journal-header {
      padding: 0.75rem 0.75rem 0.6rem;
      padding-right: 3rem;
    }
    .journal-body {
      padding: 0.75rem;
    }
    .journal-card {
      padding: 0.6rem 0.7rem;
    }
  }
</style>
