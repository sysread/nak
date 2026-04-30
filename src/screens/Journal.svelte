<script lang="ts">
  /*
   * Journal panel - inline daily-view surface. The sidebar JournalList
   * component is the day-index browse surface; clicking a date there
   * sets route.journal_date and mounts this panel on that day's entries.
   *
   * route.journal_date carries the focused day. When absent the panel
   * defaults to today via the local-timezone helper. Date navigation
   * (prev/next/today buttons) lives in Chat.svelte's top-bar and calls
   * navigate({ journal_date: ... }) directly using shiftDay from
   * $lib/journal-day.
   *
   * Compose mode (new entry / edit entry) is entirely panel-local state
   * and is not routed - it's a transient form state, not bookmarkable.
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
    regenerateAutomaticEntry,
    acceptRegeneratedEntry,
  } from '$lib/journal-store.svelte';
  import { downloadEntryMarkdown } from '$lib/journal-export';
  import { todayInZone, formatDateFull } from '$lib/journal-day';
  import { onJournalChange } from '$lib/journal-events';
  import Markdown from '../components/Markdown.svelte';
  import type { JournalEntry } from '$lib/supabase';

  // Cap parallels MAX_JOURNAL_CONTENT_CHARS in
  // src/lib/agents/journal/types.ts - a user entry and an agent entry
  // live in the same column, so they should respect the same ceiling.
  const MAX_ENTRY_CHARS = 16000;
  interface Props {
    // When Chat.svelte's top-bar "new entry" button flips this to true,
    // the panel opens the compose form and resets it.
    triggerNewEntry?: boolean;
  }
  let { triggerNewEntry = $bindable(false) }: Props = $props();

  const MAX_MOOD_CHARS = 80;
  const MAX_TOPIC_CHARS = 60;
  const MAX_PERSON_CHARS = 60;

  const today = $derived(todayInZone(app.journalTimezone || null));
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

  // Regenerate-button state. Only one entry can be in regenerate
  // mode at a time - the proposed replacement is shown in place of
  // the entry's body until the user picks Accept / Try again / Cancel.
  // Persistence is held off until Accept so Cancel can revert
  // cleanly without round-tripping the DB. Try again re-runs the
  // agent against the original entry (not the previous proposal),
  // so the user always gets a fresh angle.
  type RegeneratePreview = {
    content: string;
    topics: string[];
    mood: string | null;
    people: string[];
  };
  let regenerateTargetId = $state<string | null>(null);
  let regenerateBusy = $state(false);
  let regeneratePreview = $state<RegeneratePreview | null>(null);
  let regenerateError = $state<string | null>(null);
  let regenerateAccepting = $state(false);
  // AbortController for the in-flight regenerate. Cancel calls
  // .abort() so the streamChat call (and the SSE socket behind it)
  // tear down promptly rather than running to completion in the
  // background.
  let regenerateController: AbortController | null = null;

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

  // Tear down any in-flight regenerate when the modal unmounts. The
  // streamChat call keeps the SSE socket open until aborted; without
  // this the worker keeps generating tokens for a panel the user
  // already closed. Stale-result guards inside startRegenerate
  // catch the resolution, but we still want the socket released.
  $effect(() => {
    return () => {
      if (regenerateController) {
        regenerateController.abort();
        regenerateController = null;
      }
    };
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
    // Switch to the Chats tab and open this thread. Clearing journal_date
    // removes the journal param from the URL so the state reads cleanly.
    navigate({ cid: threadId, drawer: null, journal_date: null });
  }

  // Chat.svelte's top-bar "new entry" button sets triggerNewEntry = true.
  // The $bindable prop lets this effect reset it (two-way).
  $effect(() => {
    if (triggerNewEntry) {
      startCompose(null);
      triggerNewEntry = false;
    }
  });

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
  // server-side guard prevented the double-train) so the green
  // border just stays. The button stays visible after a successful
  // mark; subsequent clicks short-circuit here so the visual is
  // honest about the state without sending a redundant RPC.
  async function onMarkHam(id: string): Promise<void> {
    if (!app.supabase || hamBusyId !== null) return;
    const target = journal.entries.find((e) => e.id === id);
    if (target?.ham_marked_at) return; // already voted; no-op
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

  // Kick off (or retry) a regenerate against the given automatic
  // entry. Holds previous state on retry: the target id stays put,
  // any prior preview is cleared so the loading state takes the
  // card slot, and the error is cleared so a successful retry
  // doesn't keep showing the prior failure. The agent is run in
  // the main thread so the UI can show its result and let the user
  // decide before persisting - the worker pipeline never touches
  // this path.
  async function startRegenerate(entry: JournalEntry): Promise<void> {
    if (!app.supabase || !app.venice) return;
    if (!entry.thread_id) return;
    // Cancel any in-flight regenerate before starting another. Two
    // concurrent regenerates against the same row would race the
    // preview state on resolution; the second-clicked one should win.
    if (regenerateController) regenerateController.abort();
    regenerateTargetId = entry.id;
    regeneratePreview = null;
    regenerateError = null;
    regenerateBusy = true;
    // Close any other inline UI on the same card so the regenerate
    // preview owns the card's body slot uncontested.
    if (deleteTargetId === entry.id) deleteTargetId = null;
    const controller = new AbortController();
    regenerateController = controller;
    try {
      const proposed = await regenerateAutomaticEntry(
        app.supabase,
        app.venice,
        entry,
        controller.signal
      );
      // Stale-result guard: if the user cancelled or moved to another
      // row while the call was in flight, drop this result.
      if (regenerateController !== controller) return;
      if (regenerateTargetId !== entry.id) return;
      regeneratePreview = proposed;
    } catch (err) {
      if (regenerateController !== controller) return;
      if (regenerateTargetId !== entry.id) return;
      regenerateError = err instanceof Error ? err.message : String(err);
    } finally {
      if (regenerateController === controller) {
        regenerateBusy = false;
        regenerateController = null;
      }
    }
  }

  function cancelRegenerate(): void {
    if (regenerateAccepting) return;
    if (regenerateController) {
      regenerateController.abort();
      regenerateController = null;
    }
    regenerateTargetId = null;
    regenerateBusy = false;
    regeneratePreview = null;
    regenerateError = null;
  }

  async function tryRegenerateAgain(): Promise<void> {
    if (!regenerateTargetId) return;
    const target = journal.entries.find((e) => e.id === regenerateTargetId);
    if (!target) return;
    await startRegenerate(target);
  }

  async function acceptRegenerate(): Promise<void> {
    if (!app.supabase || !regenerateTargetId || !regeneratePreview) return;
    if (regenerateAccepting) return;
    regenerateAccepting = true;
    try {
      await acceptRegeneratedEntry(
        app.supabase,
        regenerateTargetId,
        regeneratePreview
      );
      regenerateTargetId = null;
      regeneratePreview = null;
      regenerateError = null;
    } catch (err) {
      regenerateError = err instanceof Error ? err.message : String(err);
    } finally {
      regenerateAccepting = false;
    }
  }

</script>

<!-- Journal panel body. Date navigation lives in Chat.svelte's top-bar
     (prev/next/today buttons calling navigate({ journal_date })). This
     component owns the date heading and the entries for the focused day,
     plus the compose mode for writing new entries. -->
<section class="journal-panel journal-body">
  <!-- Date heading. Sits at the top of the scrollable body so the user
       always knows which day they're reading, independent of the top-bar. -->
  <h2 class="journal-day-heading">{formatDateFull(focusedDate)}</h2>
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
            Nothing saved for this day. Use the new-entry button above
            to start one, or keep chatting - the automatic journaler
            will fill in a page once it has something worth writing.
          </p>
        {/if}

      <!-- "Write an entry" button removed: the top-bar new-entry button
           is the primary compose affordance now. -->
</section>

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
  {@const isRegenerating = regenerateTargetId === entry.id}
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
    <!--
      Regenerate preview takes over the card body when the user has
      asked for a rewrite. The chips/people from the ORIGINAL entry
      are hidden during preview because the proposed replacement
      carries its own metadata - showing both at once would conflate
      two versions in one card.
    -->
    {#if isRegenerating}
      {#if regenerateBusy && !regeneratePreview}
        <div class="journal-card-body">
          <p class="subtle">Regenerating this entry…</p>
        </div>
      {:else if regeneratePreview}
        <div class="journal-card-chips">
          <span class="journal-badge badge-regenerate">Proposed</span>
          {#if regeneratePreview.mood}
            <span class="chip">mood: {regeneratePreview.mood}</span>
          {/if}
          {#each regeneratePreview.topics as t}
            <span class="chip">{t}</span>
          {/each}
        </div>
        <div class="journal-card-body">
          <Markdown content={regeneratePreview.content} />
        </div>
        {#if regeneratePreview.people.length > 0}
          <p class="subtle journal-people">
            People: {regeneratePreview.people.join(', ')}
          </p>
        {/if}
      {:else if regenerateError}
        <div class="journal-card-body">
          <p class="error">{regenerateError}</p>
        </div>
      {/if}
    {:else}
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
    {/if}
    <footer class="journal-card-actions">
      {#if isRegenerating}
        <!--
          Regenerate-mode footer. Cancel reverts to the original
          entry (no DB write). Try again re-runs the agent against
          the original (not the proposal), so each retry takes a
          fresh angle. Accept persists the proposal via
          updateJournalEntry. Buttons are ordered Cancel / Try
          again / Accept so the primary action sits on the right
          where the eye lands at the end of the row.
        -->
        <span class="subtle journal-delete-prompt">
          {regeneratePreview
            ? 'Replace existing entry with this version?'
            : regenerateError
            ? 'Regenerate failed.'
            : ''}
        </span>
        <button
          type="button"
          class="secondary"
          onclick={cancelRegenerate}
          disabled={regenerateAccepting}
        >Cancel</button>
        <button
          type="button"
          class="secondary"
          onclick={tryRegenerateAgain}
          disabled={regenerateBusy || regenerateAccepting}
          title="Run the journaler again for a different take"
        >{regenerateBusy ? 'Trying…' : 'Try again'}</button>
        {#if regeneratePreview}
          <button
            type="button"
            onclick={acceptRegenerate}
            disabled={regenerateAccepting}
          >{regenerateAccepting ? 'Saving…' : 'Accept'}</button>
        {/if}
      {:else}
        <button
          type="button"
          class="secondary"
          onclick={() => downloadEntryMarkdown(entry)}
          title="Download this entry as Markdown"
        >Export .md</button>
        <!--
          Spam-filter votes. Thumbs-up trains the source conversation's
          tokens as ham; thumbs-down (Delete) trains them as spam AND
          deletes the entry + adds the thread to journal_thread_excludes.
          Both buttons stay visible once the entry has a thread; the
          thumbs-up gets a green border (.is-voted) once ham_marked_at
          flips so the durable vote state lives on the button itself
          rather than being replaced by a separate "you voted" tag.
          Re-clicking an already-hammed thumbs-up is a no-op (the click
          handler short-circuits when ham_marked_at is set) - the visual
          state is the indicator. aria-label + title carry the verb for
          keyboard / screen-reader users.
        -->
        {#if entry.thread_id}
          <button
            type="button"
            class="secondary journal-vote-btn"
            class:is-voted={entry.ham_marked_at !== null}
            aria-label="Looks good"
            aria-pressed={entry.ham_marked_at !== null}
            onclick={() => onMarkHam(entry.id)}
            disabled={hamBusyId === entry.id}
            title={entry.ham_marked_at !== null
              ? 'You marked this entry as appropriate.'
              : 'Looks good - tell the spam filter this kind of conversation IS journal-worthy'}
          >{hamBusyId === entry.id ? '…' : '👍'}</button>
          <!--
            Regenerate. Sits between thumbs-up and thumbs-down so the
            row reads as "approve / rewrite / reject". Only available
            when the source thread still exists - the agent needs the
            messages to feed the model.
          -->
          <button
            type="button"
            class="secondary journal-vote-btn"
            aria-label="Regenerate this entry"
            onclick={() => startRegenerate(entry)}
            title="Regenerate - have the journaler write a different take on this conversation"
          >🔄</button>
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
      {/if}
    </footer>
    {#if deleteTargetId === entry.id && deleteError}
      <p class="error">{deleteError}</p>
    {/if}
    {#if hamErrorId === entry.id && hamError}
      <p class="error">{hamError}</p>
    {/if}
    {#if isRegenerating && regeneratePreview && regenerateError}
      <p class="error">{regenerateError}</p>
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

  .journal-empty-day-text {
    margin: 1rem 0;
  }

  /* Date heading at the top of the scrollable body. Centered and sized
     to read as a clear section title above the day's entries without
     competing with the entry text. */
  .journal-day-heading {
    margin: 0 0 1.25rem;
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text);
    text-align: center;
    letter-spacing: 0.01em;
  }

  /* Inline journal panel. Fills the main content column as a flex
     item; .chat (the parent) is already flex-column. */
  .journal-panel {
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: var(--surface);
  }

  .journal-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    height: 100%;
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
    /* 1.75 = ~25% above the default 1.4 body line-height. Journal prose
       is longer-form than chat messages; the extra leading makes multi-
       paragraph entries easier to scan without feeling cramped. */
    line-height: 1.75;
    color: var(--text);
    /* Mirror .msg's wrapping rules so the rendered markdown wraps to
       the card's width rather than running off the right edge. */
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

  /* Selected state for a vote button (currently only the thumbs-up
     once the user has marked the entry as ham). Green border via
     the project-wide --ok token (theme-aware: light/dark each pick
     a contrast-appropriate green). 1.5px width so the indication
     reads even when the button sits next to other secondary buttons
     with the same neutral border, with an offsetting padding shave
     so the button doesn't jitter sideways when it flips state.
     :hover override pins the green - .secondary:hover would
     otherwise repaint the border. */
  .journal-vote-btn.is-voted,
  .journal-vote-btn.is-voted:hover {
    border-color: var(--ok);
    border-width: 1.5px;
    padding-inline: calc(0.45rem - 0.5px);
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

  /* Proposed-replacement badge worn by the regenerate preview. Uses
     --warn rather than --accent so it reads as "this is a pending
     decision the user has to confirm" rather than blending with the
     usual user/automatic badge palette. */
  .badge-regenerate {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
    border-color: var(--warn);
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

  @media (max-width: 720px) {
    .journal-body {
      padding: 0.75rem;
    }
    .journal-card {
      padding: 0.6rem 0.7rem;
    }
  }
</style>
