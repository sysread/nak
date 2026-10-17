<script lang="ts">
  /*
   * Records section, rendered at the bottom of the Cookbook detail pane,
   * below the History panel (Cookbook.svelte mounts it). Records are
   * dated entries linked to the recipe: the cooking log (what happened
   * when the user cooked it, how it went, what to try next), distinct
   * from the cooklang body's distilled "current state".
   *
   * This component owns the log list, its filters (date range + tag,
   * hidden during a live search; outcome, live in both modes), a
   * CROSS-RECIPE semantic search whose hit clicks navigate the detail
   * pane (expand + scroll-highlight), the per-record expand/collapse,
   * and the inline compose/edit form. All decision logic (the
   * retention-map reducer, filter mapping, chips, labels, slugs) lives
   * in $lib/ui/recipe-records.ts; this file is the Svelte glue.
   *
   * MOUNT CONTRACT: Cookbook.svelte mounts this section on "detail pane
   * open AND a recipe id selected" - NOT inside the {#if activeRecipe}
   * content gate, and NOT keyed by recipe id. A cross-recipe search
   * survives its first click: the pane's by-id fallback fetch can leave
   * activeRecipe undefined mid-navigation, and remounting here would
   * silently kill query, results, and highlight (the plan's round-8
   * finding). Only the per-recipe log refetches, via the retention map.
   *
   * OFFLINE: reads degrade soft - the per-recipe retention map (kept
   * for the session) is what the log area renders, online included;
   * writes and the filter/search SUBMISSIONS disable with copy, while
   * the search box stays editable and clearable (clearing is a
   * retention-map read, not a server call). Records join no offline
   * mirror - the relay does not syncOfflineCache.
   *
   * Data refresh: the load effect refetches on recipeId change and on
   * the onRecipeRecordChange bus (the section's own writes fire it
   * directly after success; the recipe_records realtime subscription
   * relays server-side writes from the chat tools through the same bus
   * - see Chat.svelte).
   */
  import { untrack } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { navigate, route } from '$lib/routing.svelte';
  import { offlineStatus } from '$lib/offline-sync.svelte';
  import { searchRecipeRecordsSemantic } from '$lib/recipe-records-search';
  import {
    downloadRecipeRecordMarkdown,
    downloadRecipeRecordZip,
  } from '$lib/recipe-records-export';
  import { emitRecipeRecordChange, onRecipeRecordChange } from '$lib/cookbook-events';
  import { MAX_RECIPE_RECORD_CONTENT_CHARS } from '$shared/recipe-record-limits';
  import type { Recipe, RecipeRecord } from '$lib/supabase';
  import { SEARCH_DEBOUNCE_MS, isSearching } from '$lib/ui/recipe-list';
  import {
    DELETED_RECIPE_LABEL,
    RECIPE_RECORD_SEARCH_LIMIT,
    browseFiltersActive,
    collectTags,
    contentPreview,
    expandedRowActions,
    formatRecordDate,
    hitClickable,
    hitLabel,
    hitTitleStateFromBatch,
    listFiltersFromBrowse,
    offlineNoDataMessage,
    outcomeChipClass,
    outcomeChipLabel,
    outcomeFilterOptions,
    outcomeFormOptions,
    parseTags,
    pruneExpandedId,
    recordActionTitle,
    recordsEmptyMessage,
    recordsHeadline,
    reduceRecipeRecordRetention,
    resetsOnRecipeChange,
    retentionEntryFor,
    serializeTags,
    todayIso,
    validateRecordForm,
    type HitTitleState,
    type RecipeRecordBrowseFilterState,
    type RecipeRecordRetentionMap,
  } from '$lib/ui/recipe-records';
  import Markdown from './Markdown.svelte';

  interface Props {
    /** The open recipe's id - the only thing the log fetch needs. */
    recipeId: string;
    /**
     * The resolved recipe row, nullable exactly during the pane's
     * resolution windows (the by-id fallback fetch in flight, or the
     * recipe gone): the export zip needs title + cooklang, so Export
     * all disables while this is null.
     */
    recipe: Recipe | null;
    /**
     * The pane's resolution state, passed down by Cookbook.svelte -
     * resolveActiveRecipe returns null for BOTH still-fetching and
     * gone, so without it the section cannot tell a resolution window
     * from a deleted recipe. Drives the scroll pinning and the
     * render-nothing mount-void (browse mode + missing).
     */
    resolution: 'resolving' | 'found' | 'missing';
  }
  const { recipeId, recipe, resolution }: Props = $props();

  const online = $derived(offlineStatus.online);

  // --- retention map (the log's source of truth) ------------------------
  // Keyed per recipe id, kept for the session; the log view renders
  // FROM the map (map[recipeId]) so a fetch landing after the open id
  // changed files itself under its own id instead of clobbering the
  // view.
  let retention = $state<RecipeRecordRetentionMap>(new Map());
  const retainedEntry = $derived(retentionEntryFor(retention, recipeId));
  const logRows = $derived(retainedEntry?.kind === 'rows' ? retainedEntry.rows : null);
  const logFailed = $derived(retainedEntry?.kind === 'error');
  // True while a log fetch for the CURRENT open id is in flight - the
  // scroll pinning waits on it (see the scroll effect).
  let logFetchInFlight = $state(false);

  // --- browse filter state ----------------------------------------------
  let fromDate = $state('');
  let toDate = $state('');
  let tagFilter = $state('');
  let outcomeFilter = $state('');

  // --- semantic search state -------------------------------------------
  // Search is cross-recipe by design (the recipe_record_search tool's
  // twin), so a hit may belong to another recipe; the row is annotated
  // with that recipe's batch-resolved title and clicking navigates.
  let searchQuery = $state('');
  let searchResults = $state<RecipeRecord[] | null>(null);
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let searchAbort: AbortController | null = null;
  // Sticky per-result-set title batch state (see HitTitleState).
  let titleState = $state<HitTitleState>({ status: 'ok', titles: new Map() });

  /** Whether a search is live: the query box holds a non-empty query. */
  const searchMode = $derived(isSearching(searchQuery));

  // --- expand / highlight / scroll state --------------------------------
  let expandedId = $state<string | null>(null);
  let highlightId = $state<string | null>(null);
  // Set by a hit click; consumed by the scroll effect once the pane's
  // resolution has settled and the log refetch has landed.
  let pendingScrollId = $state<string | null>(null);
  let sectionEl = $state<HTMLElement | null>(null);

  // --- compose / edit form ----------------------------------------------
  let composing = $state(false);
  let editingId = $state<string | null>(null);
  let formDate = $state('');
  let formContent = $state('');
  let formTags = $state('');
  let formOutcome = $state('');
  let formBusy = $state(false);
  let formError = $state<string | null>(null);

  // --- misc --------------------------------------------------------------
  let exportBusy = $state(false);
  // Write-error line (record delete, Export all). Fetch errors live in
  // the retention map instead - they are keyed per recipe id.
  let actionError = $state<string | null>(null);

  const availableTags = $derived(collectTags(logRows ?? []));
  const visible = $derived(searchResults ?? logRows ?? []);
  const headline = $derived(recordsHeadline(visible.length));
  const browseEmpty = $derived(
    recordsEmptyMessage({
      filtered: browseFiltersActive(currentBrowseFilters()),
      searching: false,
    })
  );

  function currentBrowseFilters(): RecipeRecordBrowseFilterState {
    return { fromDate, toDate, tag: tagFilter, outcome: outcomeFilter };
  }

  /**
   * Fetch one recipe's log into the retention map under ITS OWN id.
   * Offline this is a no-op - reads come from the map, and a failed
   * refetch must not look like an empty log. `filters` is passed (not
   * read from state) so call sites decide which filter snapshot a
   * fetch sees: the id-change effect fetches the post-reset (default)
   * state, filter changes fetch the live state.
   */
  async function loadLog(
    id: string,
    filters: ReturnType<typeof listFiltersFromBrowse>
  ): Promise<void> {
    if (!app.supabase || !offlineStatus.online) return;
    logFetchInFlight = true;
    try {
      const rows = await app.supabase.listRecipeRecords(id, filters);
      retention = reduceRecipeRecordRetention(retention, {
        type: 'fetch-landed',
        recipeId: id,
        rows,
      });
    } catch {
      retention = reduceRecipeRecordRetention(retention, {
        type: 'fetch-failed',
        recipeId: id,
      });
    } finally {
      // Only the open id's fetch gates the scroll pinning; a late
      // response for a previous id just files into the map.
      if (id === recipeId) logFetchInFlight = false;
    }
  }

  function resetComposeForm(): void {
    // An edit form targets a specific record of the previous recipe;
    // kept open with a blanked draft it would write the old record
    // from the new pane - so the reset closes the form outright.
    composing = false;
    editingId = null;
    formDate = '';
    formContent = '';
    formTags = '';
    formOutcome = '';
    formError = null;
  }

  // Load + relay effect, keyed on the open recipe id. Resets apply
  // BEFORE the refetch reads any filter state: the map's fetch here
  // reads the post-reset (default) browse filters, so the live-search
  // dropdown value never seeds the map. The relay callback reads the
  // CURRENT state at fire time (untracked - it runs outside this
  // effect's dependency capture).
  $effect(() => {
    const id = recipeId;
    if (!id) return;
    // Date/tag filters and the compose/edit draft reset on EVERY path
    // (hit click or sidebar click). Outcome + expanded row reset only
    // in browse mode: while a search is live the outcome filters the
    // search (resetting it would desync the dropdown from the displayed
    // results) and a search-result expansion survives until the search
    // clears (collapsing it would fight the scroll-highlight).
    fromDate = '';
    toDate = '';
    tagFilter = '';
    resetComposeForm();
    // The matrix's conditional half (outcome + expanded row reset only
    // in browse mode) - wired through the tested primitive so the
    // matrix and the shipped wiring cannot drift.
    const resets = resetsOnRecipeChange(untrack(() => searchMode));
    if (resets.outcome) outcomeFilter = '';
    if (resets.expandedRow) expandedId = null;
    void untrack(() => loadLog(id, {}));
    const off = onRecipeRecordChange(() => {
      if (untrack(() => searchMode)) {
        // Relay events re-run a live search through the same
        // controller, so a record-writing chat turn cannot thrash the
        // search. The log refetch waits for the search to clear -
        // fetching here would seed the map with the live-search
        // outcome value.
        void runSearch();
        return;
      }
      void loadLog(id, listFiltersFromBrowse(currentBrowseFilters()));
    });
    return () => off();
  });

  // Reconnect re-arms a fetch the offline no-op skipped: navigating to
  // a recipe while offline leaves its id without a map entry, and the
  // browse view would sit on "Loading records…" forever (nothing else
  // re-arms it). Cold fetch only - a map entry holding rows or an
  // error stays until its own triggers refetch it. Declared AFTER the
  // id-change effect so a mount-time double fetch is impossible (the
  // first effect's loadLog has already set the in-flight flag).
  $effect(() => {
    const id = recipeId;
    if (!id || searchMode) return;
    if (logRows !== null || logFailed) return;
    if (!offlineStatus.online) return;
    if (untrack(() => logFetchInFlight)) return;
    void untrack(() => loadLog(id, listFiltersFromBrowse(currentBrowseFilters())));
  });
  // the query and connectivity - never the results state - so a
  // landing search cannot re-arm this effect.
  $effect(() => {
    const q = searchQuery.trim();
    if (q.length === 0) {
      // Emptying the box exits search through the SAME transition as
      // the Clear button - one exit shape, so the outcome dropdown
      // cannot desync from the rendered log. (No-op when no search is
      // live: state is already clear.)
      if (searchResults !== null) clearSearch();
      else {
        searchResults = null;
        searchError = null;
        searching = false;
        if (searchAbort) searchAbort.abort();
        searchAbort = null;
      }
      return;
    }
    // Offline the box stays editable and clearable, but new queries
    // are gated: both legs are server calls, and a failed refetch
    // must not look like an empty log. Already-fetched results stay
    // rendered - the gate clears nothing.
    if (!offlineStatus.online) return;
    const timer = setTimeout(() => void runSearch(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // Expanded-row pruning: a search-result expansion dies when the
  // search clears (it is no longer in the rendered set); while
  // browsing, a row deleted or filtered out of the log takes its
  // expansion with it. Results LANDING does not prune - a browse-row
  // expansion is kept across a search so clearing restores it.
  $effect(() => {
    const results = searchResults;
    if (results !== null) return;
    const id = expandedId;
    if (!id) return;
    const rows = logRows;
    if (rows) expandedId = pruneExpandedId(id, rows);
  });

  // Scroll pinning for a hit click: waits for the pane's resolution to
  // settle AND the open id's log refetch to land - a scroll issued at
  // click time would land on a section that the body render then
  // pushes out of view. Fires even when navigation was a no-op (a hit
  // on the open recipe) and offline (no fetch gates it).
  $effect(() => {
    const target = pendingScrollId;
    if (!target) return;
    if (resolution === 'resolving') return;
    if (logFetchInFlight) return;
    const root = sectionEl;
    if (!root) return;
    const el = Array.from(root.querySelectorAll<HTMLElement>('[data-record-id]')).find(
      (n) => n.dataset.recordId === target
    );
    if (!el) return;
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pendingScrollId = null;
  });

  async function runSearch(): Promise<void> {
    if (!app.supabase) return;
    const q = searchQuery.trim();
    if (!q) return;
    // Supersede any in-flight call so a slow embed from a stale query
    // can't clobber a newer one (RecipeList's discipline; the relay
    // re-search and an outcome change share the same controller).
    if (searchAbort) searchAbort.abort();
    const ctl = new AbortController();
    searchAbort = ctl;
    searching = true;
    searchError = null;
    try {
      const hits = await searchRecipeRecordsSemantic({
        query: q,
        limit: RECIPE_RECORD_SEARCH_LIMIT,
        // A set outcome dropdown is passed into the search call, so
        // "failures about X" works in the UI, not just via the tools.
        outcome: outcomeFilter || undefined,
        supabase: app.supabase,
        signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      searchResults = hits;
      // A new result set is a new story: the highlight marks one
      // specific result, so a re-search (relay or keystroke) clears it.
      highlightId = null;
      // Pending until the title batch lands: with an empty ok-map here,
      // every foreign hit would flash "(deleted recipe)" for the batch
      // round trip - the label must not preempt the lookup's verdict.
      titleState = { status: 'pending' };
      try {
        const ids = Array.from(new Set(hits.map((h) => h.recipe_id)));
        const titles = await app.supabase.fetchRecipeTitles(ids);
        if (ctl.signal.aborted) return;
        titleState = hitTitleStateFromBatch(titles);
      } catch {
        if (ctl.signal.aborted) return;
        titleState = hitTitleStateFromBatch(null);
      }
    } catch (err) {
      if (ctl.signal.aborted) return;
      searchError = err instanceof Error ? err.message : 'Search failed.';
      searchResults = [];
    } finally {
      if (searchAbort === ctl) {
        searchAbort = null;
        searching = false;
      }
    }
  }

  function clearSearch(): void {
    // Abort an in-flight search first: without it, a landing response
    // would repopulate searchResults after the clear (the then-handler
    // only skips when its own controller was aborted).
    if (searchAbort) searchAbort.abort();
    searchAbort = null;
    searching = false;
    searchQuery = '';
    searchResults = null;
    searchError = null;
    titleState = hitTitleStateFromBatch(new Map());
    highlightId = null;
    // Restored, reset: the date/tag controls come back with cleared
    // values, and the outcome dropdown resets with them - otherwise
    // browse would open on the searched outcome.
    fromDate = '';
    toDate = '';
    tagFilter = '';
    outcomeFilter = '';
    // Browse reads the retention map; online, revalidate so a tool
    // turn that wrote during the search shows up. Offline this is a
    // retention-map read (loadLog no-ops) - the clear must work with
    // no network, or a mid-search drop traps the user in the results.
    void loadLog(recipeId, {});
  }

  function refetchLog(): void {
    void loadLog(recipeId, listFiltersFromBrowse(currentBrowseFilters()));
  }

  function onOutcomeChange(): void {
    // An outcome change that only refetched the log would silently
    // stop affecting the displayed results: with a live search it
    // re-runs the search through the same controller, with no live
    // search it just refetches the log.
    if (searchMode) {
      void runSearch();
      return;
    }
    refetchLog();
  }

  function startCompose(): void {
    resetComposeForm();
    composing = true;
    formDate = todayIso();
  }

  function startEdit(record: RecipeRecord): void {
    resetComposeForm();
    composing = true;
    editingId = record.id;
    formDate = record.date;
    formContent = record.content;
    formTags = serializeTags(record.tags);
    formOutcome = record.outcome ?? '';
  }

  function cancelForm(): void {
    resetComposeForm();
  }

  async function saveForm(): Promise<void> {
    if (!app.supabase || !recipeId) return;
    const content = formContent.trim();
    const invalid = validateRecordForm(content, formDate);
    if (invalid) {
      formError = invalid;
      return;
    }
    formBusy = true;
    formError = null;
    const tags = parseTags(formTags);
    try {
      if (editingId) {
        // The selector's "Unclassified" option sends an explicit null
        // patch - the one way an edit clears the classification.
        await app.supabase.updateRecipeRecord(editingId, {
          date: formDate,
          content,
          tags,
          outcome: formOutcome || null,
        });
      } else {
        await app.supabase.createRecipeRecord({
          recipeId,
          date: formDate,
          content,
          tags,
          outcome: formOutcome || null,
        });
      }
      emitRecipeRecordChange();
      resetComposeForm();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Failed to save record.';
    } finally {
      formBusy = false;
    }
  }

  async function deleteRecord(record: RecipeRecord): Promise<void> {
    if (!app.supabase) return;
    if (!window.confirm('Delete this record? This cannot be undone.')) return;
    try {
      await app.supabase.deleteRecipeRecord(record.id);
      emitRecipeRecordChange();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Failed to delete record.';
    }
  }

  async function exportAll(): Promise<void> {
    if (!app.supabase || !recipe) return;
    exportBusy = true;
    actionError = null;
    try {
      let rows: RecipeRecord[];
      if (offlineStatus.online) {
        // Fresh UNFILTERED fetch at export time - a separate call site
        // that BYPASSES the retention map, whose entries hold whatever
        // the fetch-time filters scoped. Export all ignores the active
        // filters/search and exports the full diary (a deliberate
        // divergence from the wiki twin, which exports its filtered
        // load).
        rows = await app.supabase.listRecipeRecords(recipeId);
      } else {
        // Offline: the retained rows as-is. If the last fetch was
        // filter-scoped the zip is a partial diary - accepted and
        // stated in the plan's offline section.
        rows = logRows ?? [];
      }
      downloadRecipeRecordZip(recipe, rows);
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Failed to export records.';
    } finally {
      exportBusy = false;
    }
  }

  function onRowClick(record: RecipeRecord): void {
    if (searchMode) {
      // SEARCH-hit clicks ALWAYS navigate (browse rows expand). A hit
      // on the open recipe navigates as a no-op but still expands,
      // highlights, and scrolls the section into view.
      openHit(record);
      return;
    }
    expandedId = expandedId === record.id ? null : record.id;
  }

  function openHit(record: RecipeRecord): void {
    // Sticky label semantics: a CONFIRMED-deleted hit (the batch
    // succeeded, the id is gone) is a no-op click; a "couldn't load"
    // row stays clickable because the blip may be transient and cached
    // recipes still open.
    if (!hitClickable(titleState, record.recipe_id)) return;
    expandedId = record.id;
    highlightId = record.id;
    pendingScrollId = record.id;
    if (route.recipe !== record.recipe_id) navigate({ recipe: record.recipe_id });
  }
</script>

{#if !searchMode && resolution === 'missing' && online}
  <!-- Render-nothing mount-void, ONLINE ONLY: an empty log under a
       not-found pane would read as "no records yet" when another
       device may have deleted the open recipe. Offline the
       offline-no-data line renders instead (the plan's precedence:
       the honest no-data treatment beats a void), and with a live
       search the section stays mounted and renders the results list
       regardless. -->
{:else}
  <section class="recipe-records" id="recipe-records" bind:this={sectionEl} aria-label="Records">
    <header class="recipe-records-header">
      <h2>{headline}</h2>
      <div class="recipe-records-header-actions">
        {#if (logRows?.length ?? 0) > 0}
          <!-- Export all: the full diary (filters/search aside) plus the
               recipe body as a ZIP. Online it fetches fresh and
               unfiltered; offline it exports the retained rows. -->
          <button
            type="button"
            class="icon-btn"
            onclick={() => void exportAll()}
            disabled={exportBusy || !recipe}
            title="Export all records"
            aria-label="Export all records"
          >
            <!-- Feather "download" - matches the twin's Export-all icon. -->
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        {/if}
        {#if !composing}
          <button
            type="button"
            class="icon-btn"
            onclick={startCompose}
            disabled={!online}
            title={recordActionTitle(online, 'add')}
            aria-label="Add record"
          >
            <!-- Feather "plus". -->
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        {/if}
      </div>
    </header>

    <!-- Cross-recipe semantic search. A hit may belong to another
         recipe; the row carries that recipe's batch-resolved title and
         the click navigates the detail pane there. Offline the box
         stays editable and clearable; only new queries are gated. -->
    <div class="recipe-records-search form-row">
      <input
        type="search"
        placeholder="Search every recipe's cooking log by meaning…"
        bind:value={searchQuery}
        autocomplete="off"
        spellcheck="false"
      />
      <button
        type="button"
        class="icon-btn"
        onclick={() => void runSearch()}
        disabled={searching || !online}
        title={online ? 'Search records' : 'Reconnect to search records'}
        aria-label={searching ? 'Searching records' : 'Search records'}
      >
        <!-- Feather "search" - matches the +/download icon buttons. -->
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      {#if searchResults}
        <button type="button" onclick={clearSearch}>Clear</button>
      {/if}
    </div>
    {#if searchError}
      <p class="error">{searchError}</p>
    {/if}

    <!-- Filters. Date/tag narrow the open recipe's log and hide while a
         search is live (results bypass them by design); the outcome
         dropdown renders and stays live in BOTH modes. All three
         disable offline - submission is a server query. -->
    <div class="recipe-records-filters">
      {#if !searchMode}
        <label>
          From
          <input
            type="date"
            bind:value={fromDate}
            onchange={refetchLog}
            disabled={!online}
            title={offlineStatus.online ? undefined : 'Reconnect to filter records'}
          />
        </label>
        <label>
          To
          <input
            type="date"
            bind:value={toDate}
            onchange={refetchLog}
            disabled={!online}
            title={offlineStatus.online ? undefined : 'Reconnect to filter records'}
          />
        </label>
        <label>
          Tag
          <select
            bind:value={tagFilter}
            onchange={refetchLog}
            disabled={!online}
            title={offlineStatus.online ? undefined : 'Reconnect to filter records'}
          >
            <option value="">All</option>
            {#each availableTags as tag (tag)}
              <option value={tag}>{tag}</option>
            {/each}
          </select>
        </label>
      {/if}
      <label>
        Outcome
        <select
          bind:value={outcomeFilter}
          onchange={onOutcomeChange}
          disabled={!online}
          title={offlineStatus.online ? undefined : 'Reconnect to filter records'}
        >
          {#each outcomeFilterOptions() as o (o.value)}
            <option value={o.value}>{o.label}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if composing}
      <div class="recipe-records-compose">
        <h3>{editingId ? 'Edit record' : 'New record'}</h3>
        <div class="form-row">
          <label for="recipe-record-date">Date</label>
          <input id="recipe-record-date" type="date" bind:value={formDate} disabled={formBusy} />
        </div>
        <div class="form-row">
          <label for="recipe-record-content">Content (Markdown)</label>
          <textarea
            id="recipe-record-content"
            bind:value={formContent}
            maxlength={MAX_RECIPE_RECORD_CONTENT_CHARS}
            disabled={formBusy}
            rows={8}
            spellcheck="true"
          ></textarea>
          <p class="subtle char-count">
            {formContent.length} / {MAX_RECIPE_RECORD_CONTENT_CHARS}
          </p>
        </div>
        <div class="form-row">
          <label for="recipe-record-tags">Tags (comma-separated)</label>
          <input
            id="recipe-record-tags"
            type="text"
            bind:value={formTags}
            disabled={formBusy}
            placeholder="rye, less-salt, variation"
            autocomplete="off"
          />
        </div>
        <div class="form-row">
          <label for="recipe-record-outcome">Outcome</label>
          <select id="recipe-record-outcome" bind:value={formOutcome} disabled={formBusy}>
            {#each outcomeFormOptions() as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
        </div>
        {#if formError}
          <p class="error">{formError}</p>
        {/if}
        <div class="row">
          <button type="button" class="primary" onclick={saveForm} disabled={formBusy || !online}>
            {formBusy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onclick={cancelForm} disabled={formBusy}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if actionError}
      <p class="error">{actionError}</p>
    {/if}

    {#if searching && searchResults === null}
      <p class="subtle">Searching…</p>
    {/if}

    {#if searchResults !== null}
      <!-- A live search's results list REPLACES the log area; the log's
           loading/empty/offline states apply only in browse mode. An
           open compose/edit form stays visible above (it renders in the
           block above regardless of mode). -->
      {#if searchResults.length === 0}
        <p class="subtle">{recordsEmptyMessage({ filtered: false, searching: true })}</p>
      {:else}
        <ul class="recipe-records-list">
          {#each searchResults as record (record.id)}
            {@render recordRow(record)}
          {/each}
        </ul>
      {/if}
    {:else if logFailed}
      <!-- Load-error banner, keyed by recipe id (the map holds it
            under the id whose cold fetch failed; a failed A fetch
            never shows its banner under B). A failed REVALIDATION
            keeps the rendered rows instead. -->
      <p class="error">
        Couldn't load the records.
        <button type="button" onclick={refetchLog}>Retry</button>
      </p>
    {:else if logRows === null}
      {#if online}
        <p class="subtle">Loading records…</p>
      {:else}
        <p class="subtle">{offlineNoDataMessage()}</p>
      {/if}
    {:else if visible.length === 0}
      <p class="subtle">{browseEmpty}</p>
    {:else}
      <ul class="recipe-records-list">
        {#each visible as record (record.id)}
          {@render recordRow(record)}
        {/each}
      </ul>
    {/if}
  </section>
{/if}

{#snippet recordRow(record: RecipeRecord)}
  {@const label = hitLabel(titleState, record.recipe_id, recipeId)}
  {@const actions = expandedRowActions(record.recipe_id, recipeId)}
  <li
    class="recipe-record"
    class:expanded={expandedId === record.id}
    class:highlighted={highlightId === record.id}
  >
    <div
      class="recipe-record-row"
      role="button"
      tabindex="0"
      data-record-id={record.id}
      onclick={() => onRowClick(record)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onRowClick(record);
        }
      }}
    >
      <span class="recipe-record-date">{formatRecordDate(record.date)}</span>
      {#if outcomeChipLabel(record.outcome)}
        <span class="recipe-record-outcome {outcomeChipClass(record.outcome)}">
          {outcomeChipLabel(record.outcome)}
        </span>
      {/if}
      <span class="recipe-record-preview">
        {expandedId === record.id ? '' : contentPreview(record.content)}
      </span>
      {#if record.tags.length > 0}
        <span class="recipe-record-tags">
          {#each record.tags as tag (tag)}
            <span class="recipe-record-chip">{tag}</span>
          {/each}
        </span>
      {/if}
      {#if label}
        <span
          class="recipe-record-recipe subtle"
          class:is-deleted={label === DELETED_RECIPE_LABEL}
        >{label}</span>
      {/if}
    </div>
    {#if expandedId === record.id}
      <div class="recipe-record-body">
        <Markdown content={record.content} />
        <!-- Affordances follow the open recipe: a kept-expanded search
             hit whose recipe stopped matching loses Edit/Delete (only
             Export renders), so the form can never write a foreign
             recipe's record from the new pane. -->
        <div class="row recipe-record-actions">
          {#if actions.edit}
            <button
              type="button"
              onclick={() => startEdit(record)}
              disabled={!online}
              title={recordActionTitle(online, 'edit')}
            >Edit</button>
          {/if}
          <button type="button" onclick={() => downloadRecipeRecordMarkdown(record)}>
            Export
          </button>
          {#if actions.delete}
            <button
              type="button"
              class="danger"
              onclick={() => void deleteRecord(record)}
              disabled={!online}
              title={recordActionTitle(online, 'delete')}
            >Delete</button>
          {/if}
        </div>
      </div>
    {/if}
  </li>
{/snippet}

<style>
  .recipe-records {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border, rgba(128, 128, 128, 0.3));
  }
  .recipe-records-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .recipe-records-header h2 {
    margin: 0;
  }
  .recipe-records-header-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .recipe-records-search {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .recipe-records-search input[type='search'] {
    flex: 1 1 auto;
  }
  .recipe-records-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .recipe-records-filters label {
    display: flex;
    flex-direction: column;
    font-size: 0.85em;
    gap: 0.25rem;
  }
  .recipe-records-compose {
    margin-bottom: 1rem;
    padding: 0.75rem;
    border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
    border-radius: var(--radius-md);
  }
  .recipe-records-compose h3 {
    margin-top: 0;
  }
  .recipe-records-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .recipe-record {
    border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
    border-radius: var(--radius-md);
  }
  /* Scroll-highlight: the "you are here" wash marking the clicked
     search hit inside the still-visible results list. */
  .recipe-record.highlighted {
    background: var(--accent-weak, rgba(128, 128, 255, 0.12));
    border-color: var(--accent, rgba(128, 128, 255, 0.6));
  }
  .recipe-record-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
  }
  .recipe-record-row:hover {
    background: var(--hover-bg, rgba(128, 128, 128, 0.08));
  }
  .recipe-record-date {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 0.85em;
    white-space: nowrap;
  }
  /* Outcome chip: tinted text on the shared chip fill, ok/warn/danger
     per classification (see outcomeChipClass in the primitives). */
  .recipe-record-outcome {
    flex: 0 0 auto;
    font-size: 0.7em;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-pill);
    background: var(--chip-bg, rgba(128, 128, 128, 0.18));
    white-space: nowrap;
  }
  .recipe-record-outcome-success {
    color: var(--ok, #22c55e);
  }
  .recipe-record-outcome-mixed {
    color: var(--warn, #eab308);
  }
  .recipe-record-outcome-failure {
    color: var(--danger, #dc2626);
  }
  .recipe-record-preview {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted, inherit);
  }
  .recipe-record-tags {
    /* Shrinkable (flex-shrink 1 + min-width 0): with 0 0 auto a
       tag-heavy record's chip row is as wide as all its chips on one
       line, which pushes the whole record row past the pane edge and
       makes the detail pane scroll horizontally. */
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .recipe-record-chip {
    font-size: 0.7em;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-pill);
    background: var(--chip-bg, rgba(128, 128, 128, 0.18));
    white-space: nowrap;
  }
  .recipe-record-recipe {
    flex: 0 0 auto;
    font-size: 0.75em;
  }
  .recipe-record-recipe.is-deleted {
    font-style: italic;
  }
  .recipe-record-body {
    padding: 0 0.75rem 0.75rem;
  }
  .recipe-record-actions {
    margin-top: 0.5rem;
  }
  /* On a narrow viewport the row's single line gets cramped; let the
     preview wrap under the date instead of clipping aggressively. */
  @media (max-width: 30rem) {
    .recipe-record-row {
      flex-wrap: wrap;
    }
    .recipe-record-preview {
      white-space: normal;
      flex-basis: 100%;
    }
  }
</style>
