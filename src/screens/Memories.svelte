<script lang="ts">
  /*
   * Memories panel - inline detail view. Mounted in the chat shell's
   * main panel when `drawerTab === 'memories'`. Sibling of
   * Cookbook.svelte and Journal.svelte; the sidebar `MemoryList` is
   * the browse surface (search + label rows), and this panel renders
   * exactly one card at a time - the memory whose id is in
   * `route.memory`. With no selection the panel renders the memory
   * changelog as its default surface (see memoriesBodySurface in
   * `$lib/ui/memories` for the full precedence).
   *
   * Both surfaces read from `memoriesStore` (see
   * `$lib/memories-store.svelte.ts`), so a sidebar keystroke filters
   * the listing and a panel-side mutation is reflected on the sidebar
   * without a refetch. The store also owns the debounced semantic-
   * search pipeline; this panel does NOT debounce on its own.
   *
   * History note: this used to be a modal reached from a footer icon
   * and a Settings button, then briefly a list-of-cards panel. Both
   * earlier shapes traded readability for breadth - a wide viewport
   * full of dense cards is hostile to actually reading any one
   * memory. The single-card detail shape parallels Cookbook (one
   * recipe at a time) and uses the sidebar list for navigation.
   */
  import { onDestroy } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    classifyMemoryConfidence,
    MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
  } from '$lib/memories';
  import {
    memoriesStore,
    runMemoriesSearch,
    patchMemoryRow,
    removeMemoryRow,
    upsertMemoryRow,
    addRelationEdge,
    removeRelationEdge,
  } from '$lib/memories-store.svelte';
  import { searchMemoriesSemantic, MAX_MEMORY_DATA_CHARS } from '$lib/memories';
  // Panel-side UI-behavior primitives - every display decision this
  // screen makes (body-surface selection, action-status vocabulary,
  // form validation, formatters) lives in the companion module; this
  // file is Svelte wire-up.
  import {
    ACTION_DONE_LINGER_MS,
    MAX_LABEL_CHARS,
    MAX_RELATION_NOTE_CHARS,
    RELATION_KINDS,
    SIMILAR_MEMORIES_LIMIT,
    type MemoryActionKind,
    type MemoryActionStatus,
    type MemorySaveState,
    type RelationKind,
    actionLabel,
    changelogMessageError,
    confidenceChipLabel,
    confidenceTooltip,
    isActionBusyForRow,
    isActionDoneFor,
    isActionSettledFor,
    isAnyActionBusyFor,
    isDuplicateRelationError,
    memoriesBodySurface,
    memoryActionNotice,
    memoryEditError,
    panelEmptyMessage,
    relationNoteError,
    relativeTime,
    saveStateNotice,
  } from '$lib/ui/memories';
  import { SEARCH_DEBOUNCE_MS } from '$lib/ui/memories-list';
  import type { Memory, MemoryRelation, SimilarMemory } from '$lib/supabase';
  import Markdown from '../components/Markdown.svelte';
  import MemoryChangelogPanel from '../components/MemoryChangelogPanel.svelte';
  import { librarianRun } from '$lib/agents/memory-librarian-run.svelte';
  import {
    memoryLibrarianLease,
    memoryLibrarianOutcome,
  } from '$lib/agents/inflight-lease.svelte';
  import {
    librarianPassInfo,
    librarianProgressAriaLabel,
    librarianStripHeading,
    stepIcon,
    type MemoryLibrarianPass,
  } from '$lib/ui/memory-librarian';
  import { onMemoryChange } from '$lib/memory-events';

  /**
   * $bindable trigger flags from the Chat shell's top-bar buttons.
   * Set true on click; this component resets to false after handling
   * the event. Same pattern Wiki.svelte uses for its librarian trigger.
   */
  let {
    triggerDeepSleep = $bindable(false),
    triggerRem = $bindable(false),
    triggerChangelog = $bindable(false),
  }: {
    triggerDeepSleep?: boolean;
    triggerRem?: boolean;
    triggerChangelog?: boolean;
  } = $props();

  // The single memory currently displayed. Selection lives on
  // `route.memory` so it survives a refresh / back / forward and can
  // be set from the sidebar `MemoryList`. The card resolves against
  // `memoriesStore.results`, which is the active search result set;
  // a memory the current query filtered out reads as "not found in
  // this view" (the user can clear the search to surface it again).
  const selectedMemory = $derived<Memory | null>(
    route.memory
      ? memoriesStore.results.find((m) => m.id === route.memory) ?? null
      : null,
  );

  // The open memory's id, isolated from its object identity. A reaffirm
  // / doubt / edit replaces the row object in `memoriesStore.results`
  // (same id, new reference); deriving the bare string means the
  // similar-memories reset effect below fires only on a real navigation,
  // not on every in-place mutation of the current card.
  const selectedMemoryId = $derived(selectedMemory?.id ?? null);

  // "Similar memories" disclosure - collapsed by default, fetches top-k
  // cosine neighbours of the open memory on first expand. Results cache
  // for the lifetime of the selection so a collapse/re-expand doesn't
  // refetch; navigating to a different memory resets back to idle (see
  // the effect below).
  type SimilarState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'loaded'; rows: SimilarMemory[] }
    | { kind: 'error'; message: string };
  let similarOpen = $state(false);
  let similarState = $state<SimilarState>({ kind: 'idle' });

  // Reset the disclosure whenever the open memory changes. Reads only
  // `selectedMemoryId` (a primitive) so it doesn't re-run on same-id
  // row replacements; the writes here aren't read in this effect, so
  // there's no feedback loop.
  $effect(() => {
    selectedMemoryId;
    similarOpen = false;
    similarState = { kind: 'idle' };
  });

  // Which row (if any) is currently in edit mode. Only one row edits
  // at a time - simplifies the "unsaved changes" semantics and stops
  // the user from silently losing an edit by clicking Edit on a
  // second row.
  let editingId = $state<string | null>(null);
  let editLabel = $state('');
  let editData = $state('');
  // Required one-line "what changed and why" note that lands in the
  // memory changelog for this edit - the user's manual equivalent of the
  // `message` param the memory_update tool requires of the assistant.
  let editMessage = $state('');
  // Save indicator for the edit form; the state vocabulary and the
  // rendered notice live in $lib/ui/memories (MemorySaveState /
  // saveStateNotice).
  let saveState = $state<MemorySaveState>({ kind: 'idle' });
  const saveNotice = $derived(saveStateNotice(saveState));

  // Delete confirmation - one row at a time, same reasoning as edits.
  let deletingId = $state<string | null>(null);
  // Required changelog note captured in the delete confirm strip, same
  // contract as the memory_delete tool's `message` param.
  let deleteMessage = $state('');

  // Relation-deletion failures used to write into `memoriesStore.error`,
  // which is the panel-wide "something is wrong with the listing"
  // channel and renders at the top of the body regardless of which
  // memory is open. A user who deleted a relation on memory A, then
  // navigated to memory B before the RPC failed, would see B's view
  // wear A's relation-delete error. Scoped to a local memoryId-tagged
  // record so the message only renders on the memory it concerns.
  let relationError = $state<{ memoryId: string; message: string } | null>(null);

  // Inline busy/feedback state for the per-card action buttons
  // (Reaffirm / Doubt / confirmed Delete). The status vocabulary,
  // the button captions, and the done/error notice all live in
  // $lib/ui/memories (MemoryActionStatus and friends).
  let actionStatus = $state<MemoryActionStatus>({ kind: 'idle' });
  let actionDoneTimer: ReturnType<typeof setTimeout> | null = null;

  function clearActionDoneTimer(): void {
    if (actionDoneTimer !== null) {
      clearTimeout(actionDoneTimer);
      actionDoneTimer = null;
    }
  }

  function scheduleActionDoneClear(
    memoryId: string,
    action: MemoryActionKind,
  ): void {
    clearActionDoneTimer();
    actionDoneTimer = setTimeout(() => {
      actionDoneTimer = null;
      // Only collapse the badge if it's still describing the same
      // success - a follow-up click that started a new action will
      // have replaced `actionStatus` with a `busy` entry, and clobbering
      // that would visually swallow the in-flight call.
      if (isActionDoneFor(actionStatus, memoryId, action)) {
        actionStatus = { kind: 'idle' };
      }
    }, ACTION_DONE_LINGER_MS);
  }

  // Inline relation picker state. Only one picker open at a time - same
  // one-modal-at-a-time discipline as edits and delete confirmations.
  // Outbound relations live on the shared store keyed by source memory
  // id; the kind list the picker offers is RELATION_KINDS (imported).
  let relatingFromId = $state<string | null>(null);
  let pickerQuery = $state('');
  let pickerCandidates = $state<Memory[]>([]);
  let pickerKind = $state<RelationKind>('supports');
  let pickerNote = $state('');
  let pickerBusy = $state(false);
  let pickerError = $state<string | null>(null);
  // Debounced picker search. Has its own timer so typing in the picker
  // input doesn't clobber the sidebar search debounce window.
  let pickerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pickerAbort: AbortController | null = null;

  // Tear down lingering side effects when the drawer tab flips away
  // from Memories (the panel un-mounts on tab change). actionDoneTimer
  // would otherwise fire a `state = idle` write into a destroyed
  // component; pickerDebounceTimer + pickerAbort would similarly tick
  // past the unmount. The picker's $effect already clears its timer on
  // dependency change, but a clean unmount path leaves nothing pending.
  onDestroy(() => {
    clearActionDoneTimer();
    if (pickerDebounceTimer !== null) {
      clearTimeout(pickerDebounceTimer);
      pickerDebounceTimer = null;
    }
    if (pickerAbort) {
      pickerAbort.abort();
      pickerAbort = null;
    }
  });

  // Initial load. Sidebar runs its own debounced search on every query
  // change; this effect only fires the very first list-fetch when the
  // panel mounts so the user lands on a non-empty list.
  $effect(() => {
    if (!app.supabase) return;
    if (memoriesStore.loaded || memoriesStore.loading) return;
    void runMemoriesSearch(app.supabase);
  });

  async function reaffirmMemory(m: Memory): Promise<void> {
    if (!app.supabase) return;
    // Same-row stacking is already blocked by the per-row
    // `disabled={isAnyActionBusyFor(actionStatus, m.id)}` on every action button -
    // a disabled button doesn't fire its onclick. The previous
    // global busy guard blocked CROSS-row clicks too: with a stale
    // in-flight action on a memory the user has since navigated
    // away from, clicking Reaffirm on the new memory was silently
    // swallowed. Removing the global mutex lets the new click
    // proceed; actionStatus does flicker as the two settle, but
    // both writes (patchMemoryRow on each memory's own id) land
    // correctly.
    clearActionDoneTimer();
    actionStatus = { kind: 'busy', action: 'reaffirm', memoryId: m.id };
    try {
      const next = await app.supabase.reaffirmMemoryConfidence(m.id);
      if (next === null) {
        // RPC returned no row - either the row was deleted out from
        // under us or RLS blocked the update. Tell the user explicitly
        // rather than silently no-op'ing.
        actionStatus = {
          kind: 'error',
          action: 'reaffirm',
          memoryId: m.id,
          message: 'memory not found',
        };
        return;
      }
      patchMemoryRow(m.id, { confidence: next });
      actionStatus = { kind: 'done', action: 'reaffirm', memoryId: m.id };
      scheduleActionDoneClear(m.id, 'reaffirm');
    } catch (err) {
      actionStatus = {
        kind: 'error',
        action: 'reaffirm',
        memoryId: m.id,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function doubtMemory(m: Memory): Promise<void> {
    if (!app.supabase) return;
    // See reaffirmMemory for the rationale on dropping the global
    // busy mutex; same shape applies here.
    clearActionDoneTimer();
    actionStatus = { kind: 'busy', action: 'doubt', memoryId: m.id };
    try {
      const next = await app.supabase.doubtMemoryConfidence(m.id);
      if (next === null) {
        actionStatus = {
          kind: 'error',
          action: 'doubt',
          memoryId: m.id,
          message: 'memory not found',
        };
        return;
      }
      patchMemoryRow(m.id, { confidence: next });
      actionStatus = { kind: 'done', action: 'doubt', memoryId: m.id };
      scheduleActionDoneClear(m.id, 'doubt');
    } catch (err) {
      actionStatus = {
        kind: 'error',
        action: 'doubt',
        memoryId: m.id,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function startRelate(m: Memory): void {
    relatingFromId = m.id;
    pickerQuery = '';
    pickerCandidates = [];
    pickerKind = 'supports';
    pickerNote = '';
    pickerBusy = false;
    pickerError = null;
    // Same one-panel-open discipline as edits/deletes.
    if (editingId) cancelEdit();
    if (deletingId) cancelDelete();
  }

  function cancelRelate(): void {
    if (pickerDebounceTimer !== null) {
      clearTimeout(pickerDebounceTimer);
      pickerDebounceTimer = null;
    }
    if (pickerAbort) {
      pickerAbort.abort();
      pickerAbort = null;
    }
    relatingFromId = null;
    pickerQuery = '';
    pickerCandidates = [];
    pickerKind = 'supports';
    pickerNote = '';
    pickerBusy = false;
    pickerError = null;
  }

  async function runPickerSearch(q: string, excludeId: string): Promise<void> {
    if (!app.supabase) return;
    if (pickerAbort) pickerAbort.abort();
    const ctl = new AbortController();
    pickerAbort = ctl;
    try {
      const hits = await searchMemoriesSemantic(q, 10, {
        supabase: app.supabase,
        signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      // Drop the source memory from the candidates so the user can't
      // self-loop - the tool schema rejects it, but we can prevent the
      // user from even trying.
      pickerCandidates = hits.filter((h) => h.id !== excludeId);
    } catch {
      // Silent - the picker just stays empty if search fails.
    } finally {
      if (pickerAbort === ctl) pickerAbort = null;
    }
  }

  // Debounced picker search. Re-runs whenever the picker query changes
  // or a picker is first opened.
  $effect(() => {
    if (!relatingFromId) return;
    const q = pickerQuery.trim();
    const sourceId = relatingFromId;
    if (pickerDebounceTimer !== null) clearTimeout(pickerDebounceTimer);
    pickerDebounceTimer = setTimeout(() => {
      pickerDebounceTimer = null;
      void runPickerSearch(q, sourceId);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (pickerDebounceTimer !== null) {
        clearTimeout(pickerDebounceTimer);
        pickerDebounceTimer = null;
      }
    };
  });

  async function submitRelation(toId: string): Promise<void> {
    if (!app.supabase || !relatingFromId) return;
    const fromId = relatingFromId;
    const note = pickerNote.trim();
    const noteError = relationNoteError(note);
    if (noteError) {
      pickerError = noteError;
      return;
    }
    pickerBusy = true;
    pickerError = null;
    try {
      const created = await app.supabase.createMemoryRelation(
        fromId,
        toId,
        pickerKind,
        note.length > 0 ? note : null,
      );
      // Hydrate the full edge row for the local map. We have the target
      // memory's label/data/confidence in the candidate list the user
      // just clicked, so synthesise the joined row without a refetch.
      const target =
        pickerCandidates.find((c) => c.id === toId) ??
        memoriesStore.results.find((r) => r.id === toId);
      if (target) {
        const edge: MemoryRelation = {
          id: created.id,
          from_memory_id: fromId,
          to_memory_id: toId,
          kind: created.kind,
          note: note.length > 0 ? note : null,
          created_at: new Date().toISOString(),
          to_label: target.label,
          to_data: target.data,
          to_confidence: target.confidence,
        };
        addRelationEdge(edge);
      }
      // Cross-row guard: if the user navigated to a different
      // memory and opened its Relate picker mid-RPC, relatingFromId
      // now points at that other memory and pickerQuery /
      // pickerCandidates / pickerAbort belong to that picker.
      // cancelRelate() here would abort the new picker's in-flight
      // search and wipe the user's typed query. addRelationEdge
      // above is fromId-keyed so the store write lands regardless.
      if (relatingFromId === fromId) cancelRelate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Unique-constraint failure = the edge already exists. Treat as
      // success from the UI's perspective; the user gets the same
      // outcome they asked for.
      if (isDuplicateRelationError(msg)) {
        // Same cross-row guard as the success path.
        if (relatingFromId === fromId) cancelRelate();
      } else if (relatingFromId === fromId) {
        // Same cross-row guard - a stale "relation failed" banner
        // on a different memory's picker would misattribute the
        // failure.
        pickerError = msg;
      }
    } finally {
      // Same cross-row guard - clearing pickerBusy on a different
      // memory's in-flight submit would flip its loading indicator
      // off mid-flight.
      if (relatingFromId === fromId) pickerBusy = false;
    }
  }

  async function deleteRelation(
    fromId: string,
    relationId: string,
  ): Promise<void> {
    if (!app.supabase) return;
    // Clear any prior relation error on this memory so the new
    // attempt's outcome is the only thing the user sees.
    if (relationError?.memoryId === fromId) relationError = null;
    try {
      await app.supabase.deleteMemoryRelation(relationId);
      removeRelationEdge(fromId, relationId);
    } catch (err) {
      relationError = {
        memoryId: fromId,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Toggle the "Similar memories" disclosure. The first expand fires
  // the fetch; collapse/re-expand reuses the cached result (or the
  // error, so a failed load shows its message again rather than
  // silently refetching). The id is captured before the await and
  // re-checked after so a navigation mid-flight can't write another
  // memory's neighbours into this card.
  async function toggleSimilar(): Promise<void> {
    similarOpen = !similarOpen;
    if (!similarOpen || similarState.kind !== 'idle') return;
    if (!app.supabase) return;
    const id = selectedMemoryId;
    if (!id) return;
    similarState = { kind: 'loading' };
    try {
      const rows = await app.supabase.searchSimilarMemories(
        id,
        SIMILAR_MEMORIES_LIMIT,
      );
      if (selectedMemoryId !== id) return;
      similarState = { kind: 'loaded', rows };
    } catch (err) {
      if (selectedMemoryId !== id) return;
      similarState = {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Navigate to a neighbour from the similar list. Upsert it into the
  // result set first so the detail panel can resolve it even when the
  // active search/browse window doesn't contain it - otherwise the link
  // lands on the "not in the current results" empty state.
  function openSimilar(mem: SimilarMemory): void {
    upsertMemoryRow(mem);
    navigate({ memory: mem.id });
  }

  function startEdit(m: Memory): void {
    editingId = m.id;
    editLabel = m.label;
    editData = m.data;
    editMessage = '';
    saveState = { kind: 'idle' };
    // Cancel any pending delete confirmation when the user pivots to
    // edit mode - two open prompts at once is confusing.
    deletingId = null;
  }

  function cancelEdit(): void {
    // Disallow cancel mid-save - the Supabase write is already in
    // flight; walking away here would leave the UI and the row
    // out-of-sync on success. Users can wait the ~200ms.
    if (saveState.kind === 'saving') return;
    editingId = null;
    editLabel = '';
    editData = '';
    editMessage = '';
    saveState = { kind: 'idle' };
  }

  async function saveEdit(): Promise<void> {
    if (!editingId) return;
    if (!app.supabase) {
      saveState = { kind: 'error', message: 'Not connected to Supabase yet.' };
      return;
    }
    const id = editingId;
    const label = editLabel.trim();
    const data = editData;
    const message = editMessage.trim();
    // Field checks (required-ness, the label/data/message caps) live
    // in memoryEditError so the copy and ordering are testable.
    const validationError = memoryEditError(label, data, message);
    if (validationError) {
      saveState = { kind: 'error', message: validationError };
      return;
    }
    saveState = { kind: 'saving' };
    try {
      const updated = await app.supabase.updateMemory(id, { label, data });
      // Append the changelog row with the post-update label. Best-effort
      // - the mutation already landed; a missed changelog entry is a
      // smaller harm than surfacing a confusing post-save error.
      try {
        await app.supabase.createMemoryChangelogEntry({
          memory_id: updated.id,
          kind: 'update',
          label_at_change: updated.label,
          message,
        });
      } catch {
        // best-effort; the edit succeeded regardless.
      }
      // Replace the row in-place so the list doesn't visually reorder
      // mid-edit. The updated_at bump is reflected on next re-search;
      // not re-querying here keeps the edit affordance stable (the
      // row we just saved stays where it was).
      patchMemoryRow(id, updated);
      // Cross-row guard: if the user navigated to a different
      // memory and clicked Edit on it before this save settled,
      // editingId now points at that other memory and the form
      // bindings are showing the user's in-progress draft on B.
      // Writing saveState='saved' here unconditionally would flash
      // a "saved" confirmation on B's edit form for a save the
      // user never initiated. patchMemoryRow above is id-keyed so
      // the store write lands correctly regardless.
      if (editingId === id) saveState = { kind: 'saved' };
    } catch (err) {
      // Same cross-row guard as the success path - a stale 'error'
      // banner painted on a different memory's edit form would
      // misattribute a failure the user didn't cause.
      if (editingId === id) {
        saveState = {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // Track dirty state while editing so the "Unsaved changes" label
  // appears the moment the user diverges from the row on the server.
  // We only compare when an edit is actually open - otherwise the
  // effect would thrash on every result-list refresh.
  $effect(() => {
    if (!editingId) return;
    const original = memoriesStore.results.find((m) => m.id === editingId);
    if (!original) return;
    // Don't demote 'saving' or 'error' into 'dirty' - those states
    // are informational and should linger until the user responds.
    if (saveState.kind === 'saving' || saveState.kind === 'error') return;
    const diverged = editLabel !== original.label || editData !== original.data;
    if (diverged) {
      if (saveState.kind !== 'dirty') saveState = { kind: 'dirty' };
    } else {
      // Back to matching the server row. Collapse 'saved' too - the
      // badge was confirming a prior save; once the fields match the
      // stored row again there's nothing pending to report.
      if (saveState.kind !== 'idle') saveState = { kind: 'idle' };
    }
  });

  function requestDelete(m: Memory): void {
    deletingId = m.id;
    deleteMessage = '';
    // Clear any lingering action status from a previous attempt against
    // this row so the confirm strip opens clean.
    if (isActionSettledFor(actionStatus, m.id)) {
      clearActionDoneTimer();
      actionStatus = { kind: 'idle' };
    }
    // Cancel an open edit on a different row - we don't want an inline
    // editor and a delete-confirm strip both visible at the same time.
    if (editingId && editingId !== m.id) cancelEdit();
  }

  function cancelDelete(): void {
    deletingId = null;
    deleteMessage = '';
  }

  async function confirmDelete(): Promise<void> {
    if (!deletingId || !app.supabase) return;
    // See reaffirmMemory for the rationale on dropping the global
    // busy mutex; same shape applies here.
    const id = deletingId;
    // Require a changelog note before the destructive write. Surfaced
    // through actionStatus so it renders in the same slot next to the
    // confirm buttons that RPC errors use.
    const message = deleteMessage.trim();
    const messageError = changelogMessageError(message, 'deleting');
    if (messageError) {
      actionStatus = {
        kind: 'error',
        action: 'delete',
        memoryId: id,
        message: messageError,
      };
      return;
    }
    // Snapshot the label before the row leaves the store - the changelog
    // entry needs it for `label_at_change` and removeMemoryRow below
    // drops the row.
    const doomed = memoriesStore.results.find((m) => m.id === id);
    clearActionDoneTimer();
    actionStatus = { kind: 'busy', action: 'delete', memoryId: id };
    try {
      await app.supabase.deleteMemory(id);
      // Append the changelog row. memory_id is null - the memory is gone
      // - so the label snapshot is what keeps the entry readable.
      // Best-effort; the delete already landed.
      if (doomed) {
        try {
          await app.supabase.createMemoryChangelogEntry({
            memory_id: null,
            kind: 'delete',
            label_at_change: doomed.label,
            message,
          });
        } catch {
          // best-effort; the delete succeeded regardless.
        }
      }
      removeMemoryRow(id);
      // If the deleted row was also the one being edited (e.g. the
      // user hit Delete from inside the editor), tear the editor
      // down so it can't reference a row that no longer exists.
      if (editingId === id) {
        editingId = null;
        editLabel = '';
        editData = '';
        saveState = { kind: 'idle' };
      }
      if (relatingFromId === id) cancelRelate();
      // Cross-row guard: if the user navigated to a different
      // memory and opened its delete confirm strip mid-RPC,
      // deletingId now points at that other memory. Clearing here
      // unconditionally would close the confirm strip the user is
      // about to interact with on B. removeMemoryRow above is
      // id-keyed so the store removal lands regardless.
      if (deletingId === id) {
        deletingId = null;
        deleteMessage = '';
      }
      // Clear our own busy state. Without this it would linger as
      // a stale spinner if anything re-renders the row before the
      // navigation away from the deleted memory completes. The
      // guard makes sure we don't stomp on a busy state another
      // action set on a different memory after our RPC started
      // (e.g. a reaffirm on memory B fired while A's delete was
      // settling).
      if (isActionBusyForRow(actionStatus, id, 'delete')) {
        actionStatus = { kind: 'idle' };
      }
      // Drop the routed selection too. Without this the panel would
      // render the "not in current results" empty state pointing at a
      // memory that no longer exists, which reads as a bug rather
      // than as the deletion the user just confirmed.
      if (route.memory === id) navigate({ memory: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      actionStatus = {
        kind: 'error',
        action: 'delete',
        memoryId: id,
        message: msg,
      };
    }
  }

  // --- Memory librarian manual-run flow --------------------------------
  //
  // The live run state (which pass, the step list, the result, any
  // error) lives in the `librarianRun` singleton, NOT here - this
  // panel is unmounted whenever the user switches drawer tabs, and a
  // run has to survive that. The panel only owns the confirmation
  // step (pre-run UI, fine to lose on navigation) and reads
  // `librarianRun.*` for everything else. See the store's preamble.
  //
  // Which pass (if any) is awaiting confirmation. The top-bar buttons
  // open this strip rather than firing the run directly - on mobile
  // there's no hover-title, so the user has no way to tell the two
  // icon buttons apart until they see the confirm copy.
  let librarianConfirm = $state<MemoryLibrarianPass | null>(null);
  const librarianConfirmInfo = $derived(
    librarianConfirm ? librarianPassInfo(librarianConfirm) : null,
  );
  // True whenever a button-triggered librarian strip (the confirm
  // prompt OR the progress/result strip) occupies the top of the panel.
  // While it's up, the panel's informational content below it - the
  // changelog default-surface and every empty-state hint - is
  // suppressed so the strip the user just summoned isn't competing with
  // noise. An actually-selected memory card is the one exception (it's
  // content, not a hint); see the leading branch of the body cascade.
  const librarianStripVisible = $derived(
    librarianConfirm !== null || librarianRun.active,
  );

  // Which surface the body renders. The precedence cascade (strip
  // suppression with the selected-card exception, loading, empty,
  // changelog default, missing-selection hint, the card) lives in
  // memoriesBodySurface; this derived is just the reactive wire-up.
  const bodySurface = $derived(
    memoriesBodySurface({
      librarianStripVisible,
      selectedInResults: selectedMemory !== null,
      hasRoutedSelection: !!route.memory,
      loading: memoriesStore.loading,
      resultCount: memoriesStore.results.length,
    }),
  );

  // A pass is in flight (this tab's own run OR any other - scheduled,
  // another device - via the in-flight lease). Disables the confirm
  // strip's Run submit, mirroring the wiki page's Run button.
  const memoryLibrarianBusy = $derived(
    librarianRun.running || memoryLibrarianLease.running,
  );
  // A pass is in flight that this tab DIDN'T start - no local step-level
  // fidelity, so the confirm strip shows a "running in the background"
  // spinner. (Our own run shows the progress strip instead.)
  const runInFlightElsewhere = $derived(
    memoryLibrarianLease.running && !librarianRun.running,
  );

  // Bridge a recovered manual-run outcome into the librarianRun store so a
  // reload (or a run that finished while this tab watched without local
  // step fidelity) re-renders the result strip. The store's applyOutcome
  // guards against clobbering a live run or re-applying the same runId, so
  // this can fire freely whenever the watched outcome changes.
  $effect(() => {
    const outcome = memoryLibrarianOutcome.outcome;
    if (outcome) librarianRun.applyOutcome(outcome);
  });

  // The top-bar buttons set the trigger flags; we translate that into
  // "open the confirm strip for this pass" rather than running. The
  // actual run starts when the user confirms via confirmLibrarianRun.
  function openLibrarianConfirm(pass: MemoryLibrarianPass): void {
    // Your own active run shows the progress strip below - nothing to
    // confirm. A pass in flight ELSEWHERE (another device, scheduled
    // background) still opens this strip: the launcher is navigation, and
    // the strip renders a "running in the background" spinner with Run
    // disabled (the wiki sparkle page pattern).
    if (librarianRun.running) return;
    librarianConfirm = pass;
  }

  function confirmLibrarianRun(): void {
    const pass = librarianConfirm;
    librarianConfirm = null;
    if (!app.supabase || pass === null) return;
    void librarianRun.start(pass, {
      supabase: app.supabase,
    });
  }

  // Watch the top-bar triggers. Reset the flag so subsequent clicks
  // re-fire cleanly. A click opens the confirmation strip rather than
  // running immediately - see openLibrarianConfirm for why.
  $effect(() => {
    if (triggerDeepSleep) {
      openLibrarianConfirm('deep-sleep');
      triggerDeepSleep = false;
    }
  });
  $effect(() => {
    if (triggerRem) {
      openLibrarianConfirm('rem');
      triggerRem = false;
    }
  });
  // Watch the changelog button. Flips the panel back to its changelog
  // default surface: deselect the open memory and dismiss whatever
  // would suppress the changelog - the confirm prompt, and a librarian
  // run strip that has already finished (a still-running pass is left
  // alone; its strip stays until it settles). With no memory selected
  // and no strip up, the body cascade lands on MemoryChangelogPanel.
  $effect(() => {
    if (triggerChangelog) {
      librarianConfirm = null;
      if (librarianRun.active && !librarianRun.running) librarianRun.clear();
      if (route.memory) navigate({ memory: null });
      triggerChangelog = false;
    }
  });

  // Refresh the memories store when a librarian run lands. The
  // librarians write directly via supabase (consolidate / invalidate /
  // relate) and bypass the in-page store, so without this the panel
  // would show stale results until the next manual search.
  onDestroy(
    onMemoryChange(() => {
      if (!app.supabase) return;
      void runMemoriesSearch(app.supabase);
    })
  );
</script>

<section class="memories-panel" aria-label="Memories">
  <div class="memories-body">
    {#if librarianConfirm !== null && librarianConfirmInfo}
      <!-- Confirmation strip - the "page" the top-bar launcher opens
           (the launcher is navigation, always enabled; the Run button
           here is the gated submit). It also tells the user which pass
           they're about to run, since the top-bar icons have no
           hover-title on touch. When a pass is already in flight
           elsewhere (another device, or a scheduled background run) the
           strip shows a "running in the background" spinner and disables
           Run - the same pattern as the wiki sparkle page. Your own
           active run shows the progress strip below instead. -->
      <aside class="librarian-strip" aria-label="Confirm librarian run">
        <header class="librarian-strip-head">
          <strong>{librarianConfirmInfo.title}</strong>
        </header>
        <p class="librarian-confirm-desc">{librarianConfirmInfo.description}</p>
        {#if runInFlightElsewhere}
          <p class="subtle librarian-inflight" aria-live="polite">
            <span class="librarian-inflight-spinner" aria-hidden="true">↻</span>
            A memory-librarian pass is running in the background…
          </p>
        {/if}
        <div class="librarian-confirm-actions">
          <button
            type="button"
            onclick={confirmLibrarianRun}
            disabled={memoryLibrarianBusy}
          >
            {librarianConfirmInfo.runLabel}
          </button>
          <button
            type="button"
            class="secondary"
            onclick={() => (librarianConfirm = null)}
          >
            Cancel
          </button>
        </div>
      </aside>
    {/if}

    {#if librarianRun.active}
      <!-- Memory librarian progress strip. Renders during a manual
           run and after it finishes, showing the step list (each
           tool call narrates itself via the dispatcher-injected
           `activity` field) and the result summary line. State lives
           in the librarianRun singleton so it survives the panel
           being unmounted mid-run (drawer-tab switch). Dismissable
           via the close button once the run settles. -->
      <aside
        class="librarian-strip"
        aria-live="polite"
        aria-label={librarianProgressAriaLabel(librarianRun.pass)}
      >
        <header class="librarian-strip-head">
          <strong>
            {librarianStripHeading(librarianRun.pass, librarianRun.running)}
          </strong>
          <button
            type="button"
            class="link-btn librarian-strip-close"
            onclick={() => librarianRun.clear()}
            disabled={librarianRun.running}
            aria-label="Dismiss librarian progress"
          >
            Dismiss
          </button>
        </header>
        {#if librarianRun.steps.length > 0}
          <ol class="librarian-steps">
            {#each librarianRun.steps as step (step.label + step.status)}
              <li class="librarian-step librarian-step-{step.status}">
                <span class="librarian-step-icon" aria-hidden="true">
                  {stepIcon(step.status)}
                </span>
                <span class="librarian-step-label">{step.label}</span>
              </li>
            {/each}
          </ol>
        {/if}
        {#if librarianRun.resultLine}
          <p class="librarian-result-line">{librarianRun.resultLine}</p>
        {/if}
        {#if librarianRun.resultText}
          <p class="librarian-result-text">{librarianRun.resultText}</p>
        {/if}
        {#if librarianRun.error}
          <p class="error librarian-error">{librarianRun.error}</p>
        {/if}
      </aside>
    {/if}

    {#if memoriesStore.error}
      <p class="error">{memoriesStore.error}</p>
    {/if}

    <!-- Surface precedence (including the strip-suppression rule and
         its selected-card exception) is decided by memoriesBodySurface;
         each branch here just renders its surface. -->
    {#if bodySurface === 'librarian-strip-only'}
      <!-- A librarian confirm/progress strip is up and there's no
           selected memory card to show. Render nothing in the content
           area: the changelog and every empty-state hint below would
           just compete with the button-triggered form for attention.
           The strip above is the whole content until it's dismissed.
           (A selected memory card resolves to the 'card' surface -
           it's real content, not a hint, so the strip coexists w/ it.) -->
    {:else if bodySurface === 'loading'}
      <p class="subtle">Loading memories…</p>
    {:else if bodySurface === 'empty'}
      <!-- Copy choice (no-matches vs the cold-account explainer)
           lives in panelEmptyMessage. -->
      <p class="subtle memories-empty">
        {panelEmptyMessage(memoriesStore.query)}
      </p>
    {:else if bodySurface === 'changelog'}
      <!-- Drawer tab is open but the user hasn't picked a row yet. The
           changelog is the default surface here (parallel to the Wiki
           tab) - a "what did I learn / forget / revise" log, with each
           row clickable to open the underlying memory. Suppression
           while a librarian strip is up is handled by the leading
           branch of this cascade, not here. -->
      <MemoryChangelogPanel />
    {:else if bodySurface === 'selection-missing'}
      <!-- route.memory points at a memory that isn't in the current
           search results. Most likely the user followed a sidebar
           link and then narrowed the search; clearing the search
           surfaces the row again. -->
      <p class="subtle memories-empty">
        That memory isn't in the current results. Clear the search to
        find it again.
      </p>
    {:else if selectedMemory}
      <!-- The 'card' surface. The truthiness re-check is TypeScript
           narrowing only - 'card' already implies the selection
           resolved against the results. -->
      {@const m = selectedMemory}
      {@const confidenceTag = classifyMemoryConfidence(m.confidence)}
      {@const actionNotice = memoryActionNotice(actionStatus, m.id)}
      <ul class="memory-list">
        <li class="memory-card" data-memory-id={m.id}>
            {#if editingId === m.id}
              <div class="memory-edit">
                <div class="form-row">
                  <label for="mem-label-{m.id}">Label</label>
                  <input
                    id="mem-label-{m.id}"
                    type="text"
                    maxlength={MAX_LABEL_CHARS}
                    bind:value={editLabel}
                  />
                  <span class="subtle char-count">
                    {editLabel.length}/{MAX_LABEL_CHARS}
                  </span>
                </div>
                <div class="form-row">
                  <label for="mem-data-{m.id}">Data</label>
                  <textarea
                    id="mem-data-{m.id}"
                    class="memory-data-edit"
                    maxlength={MAX_MEMORY_DATA_CHARS}
                    bind:value={editData}
                  ></textarea>
                  <span class="subtle char-count">
                    {editData.length}/{MAX_MEMORY_DATA_CHARS}
                  </span>
                </div>
                <!-- Required changelog note for this edit. Mirrors the
                     memory_update tool's `message` param so a human edit
                     and an assistant edit leave the same kind of trail. -->
                <div class="form-row">
                  <label for="mem-message-{m.id}">Change message</label>
                  <input
                    id="mem-message-{m.id}"
                    type="text"
                    maxlength={MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}
                    placeholder="What changed and why"
                    bind:value={editMessage}
                  />
                  <span class="subtle char-count">
                    {editMessage.length}/{MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}
                  </span>
                </div>
                <div class="memory-edit-footer">
                  <div class="memory-save-state" aria-live="polite">
                    <!-- Copy + styling per save state live in
                         saveStateNotice; idle renders nothing. -->
                    {#if saveNotice}
                      <span class={saveNotice.className}>{saveNotice.text}</span>
                    {/if}
                  </div>
                  <div class="memory-edit-actions">
                    <button
                      type="button"
                      class="secondary"
                      onclick={cancelEdit}
                      disabled={saveState.kind === 'saving'}
                    >Cancel</button>
                    <button
                      type="button"
                      onclick={saveEdit}
                      disabled={saveState.kind === 'saving' || saveState.kind === 'idle'}
                    >Save</button>
                  </div>
                </div>
              </div>
            {:else}
              <div class="memory-view">
                <div class="memory-header-row">
                  <span class="memory-card-label">{m.label}</span>
                  <!-- Qualitative tag when confidence is outside the
                       neutral band; otherwise a quiet numeric chip so
                       the raw value stays visible. The tooltip carries
                       the exact number either way. -->
                  {#if confidenceTag}
                    <span
                      class="memory-confidence-tag tag-{confidenceTag}"
                      title={confidenceTooltip(m.confidence)}
                    >{confidenceTag}</span>
                  {:else}
                    <span
                      class="subtle memory-confidence-chip"
                      title={confidenceTooltip(m.confidence)}
                    >{confidenceChipLabel(m.confidence)}</span>
                  {/if}
                  <span class="subtle memory-card-meta" title={m.updated_at}>
                    {relativeTime(m.updated_at)}
                  </span>
                </div>
                <div class="memory-card-data">
                  <Markdown content={m.data} />
                </div>
                {#if relationError?.memoryId === m.id}
                  <!-- Scoped to this memory only - see relationError
                       declaration for why this isn't sharing the
                       panel-wide memoriesStore.error channel. -->
                  <p class="error memory-relation-error">
                    Couldn't remove relation - {relationError.message}
                  </p>
                {/if}
                {#if (memoriesStore.relations.get(m.id) ?? []).length > 0}
                  <ul class="memory-relations">
                    {#each memoriesStore.relations.get(m.id) ?? [] as edge (edge.id)}
                      <li class="memory-relation">
                        <span class="memory-relation-kind kind-{edge.kind}">
                          {edge.kind}
                        </span>
                        {#if classifyMemoryConfidence(edge.to_confidence)}
                          <span
                            class="memory-confidence-tag tag-{classifyMemoryConfidence(edge.to_confidence)}"
                          >{classifyMemoryConfidence(edge.to_confidence)}</span>
                        {/if}
                        <span class="memory-relation-label">
                          {edge.to_label}
                        </span>
                        {#if edge.note}
                          <span class="subtle memory-relation-note">
                            - {edge.note}
                          </span>
                        {/if}
                        <button
                          type="button"
                          class="memory-relation-remove"
                          aria-label="Remove relation"
                          title="Remove relation"
                          onclick={() => deleteRelation(m.id, edge.id)}
                        >×</button>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <div class="memory-card-actions">
                  <button
                    type="button"
                    class="secondary"
                    onclick={() => startEdit(m)}
                    disabled={isAnyActionBusyFor(actionStatus, m.id)}
                  >Edit</button>
                  <button
                    type="button"
                    class="secondary"
                    class:is-busy={isActionBusyForRow(actionStatus, m.id, 'reaffirm')}
                    onclick={() => reaffirmMemory(m)}
                    disabled={isAnyActionBusyFor(actionStatus, m.id)}
                    aria-busy={isActionBusyForRow(actionStatus, m.id, 'reaffirm') ? 'true' : undefined}
                    title="Nudge confidence upward (+0.5)"
                  >{actionLabel('reaffirm', isActionBusyForRow(actionStatus, m.id, 'reaffirm'))}</button>
                  <button
                    type="button"
                    class="secondary"
                    class:is-busy={isActionBusyForRow(actionStatus, m.id, 'doubt')}
                    onclick={() => doubtMemory(m)}
                    disabled={isAnyActionBusyFor(actionStatus, m.id)}
                    aria-busy={isActionBusyForRow(actionStatus, m.id, 'doubt') ? 'true' : undefined}
                    title="Nudge confidence downward (x0.7)"
                  >{actionLabel('doubt', isActionBusyForRow(actionStatus, m.id, 'doubt'))}</button>
                  <button
                    type="button"
                    class="secondary"
                    onclick={() => startRelate(m)}
                    disabled={isAnyActionBusyFor(actionStatus, m.id) || relatingFromId === m.id}
                  >+ Relate</button>
                  {#if deletingId === m.id}
                    <span class="subtle memory-delete-prompt">Really delete?</span>
                    <!-- Required changelog note for the deletion, same
                         contract as the memory_delete tool's `message`. -->
                    <input
                      type="text"
                      class="memory-delete-message"
                      maxlength={MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}
                      placeholder="Why delete this?"
                      bind:value={deleteMessage}
                      disabled={isActionBusyForRow(actionStatus, m.id, 'delete')}
                    />
                    <button
                      type="button"
                      class="secondary"
                      onclick={cancelDelete}
                      disabled={isActionBusyForRow(actionStatus, m.id, 'delete')}
                    >Cancel</button>
                    <button
                      type="button"
                      class="danger"
                      class:is-busy={isActionBusyForRow(actionStatus, m.id, 'delete')}
                      onclick={confirmDelete}
                      disabled={isAnyActionBusyFor(actionStatus, m.id)}
                      aria-busy={isActionBusyForRow(actionStatus, m.id, 'delete') ? 'true' : undefined}
                    >{actionLabel('delete', isActionBusyForRow(actionStatus, m.id, 'delete'))}</button>
                  {:else}
                    <button
                      type="button"
                      class="secondary"
                      onclick={() => requestDelete(m)}
                      disabled={isAnyActionBusyFor(actionStatus, m.id)}
                    >Delete</button>
                  {/if}
                  <!-- Done/error pulse. Anchored to the actions row so
                       the success or failure reads next to the button
                       the user just hit, mirroring the edit form's
                       memory-save-state cue. aria-live so screen
                       readers pick up the state transition without
                       any extra focus management. -->
                  {#if actionNotice}
                    <span
                      class="memory-action-state {actionNotice.className}"
                      aria-live="polite"
                    >{actionNotice.text}</span>
                  {/if}
                </div>
                {#if relatingFromId === m.id}
                  <div class="memory-relate-picker">
                    <div class="form-row">
                      <label for="relate-kind-{m.id}">Kind</label>
                      <select
                        id="relate-kind-{m.id}"
                        bind:value={pickerKind}
                      >
                        {#each RELATION_KINDS as kind}
                          <option value={kind}>{kind}</option>
                        {/each}
                      </select>
                    </div>
                    <div class="form-row">
                      <label for="relate-query-{m.id}">Target</label>
                      <input
                        id="relate-query-{m.id}"
                        type="search"
                        placeholder="Search memories to link..."
                        bind:value={pickerQuery}
                        autocomplete="off"
                        spellcheck="false"
                      />
                    </div>
                    {#if pickerCandidates.length > 0}
                      <ul class="memory-relate-candidates">
                        {#each pickerCandidates as cand (cand.id)}
                          <li>
                            <button
                              type="button"
                              class="memory-relate-candidate"
                              disabled={pickerBusy}
                              onclick={() => submitRelation(cand.id)}
                            >
                              {#if classifyMemoryConfidence(cand.confidence)}
                                <span
                                  class="memory-confidence-tag tag-{classifyMemoryConfidence(cand.confidence)}"
                                >{classifyMemoryConfidence(cand.confidence)}</span>
                              {/if}
                              <span class="memory-relate-candidate-label">
                                {cand.label}
                              </span>
                              <span class="subtle memory-relate-candidate-data">
                                {cand.data}
                              </span>
                            </button>
                          </li>
                        {/each}
                      </ul>
                    {:else if pickerQuery.trim().length > 0}
                      <p class="subtle memory-relate-empty">
                        No candidates match "{pickerQuery.trim()}".
                      </p>
                    {/if}
                    <div class="form-row">
                      <label for="relate-note-{m.id}">Note (optional)</label>
                      <input
                        id="relate-note-{m.id}"
                        type="text"
                        maxlength={MAX_RELATION_NOTE_CHARS}
                        bind:value={pickerNote}
                        placeholder="Short rationale for the link..."
                      />
                    </div>
                    {#if pickerError}
                      <p class="error">{pickerError}</p>
                    {/if}
                    <div class="memory-edit-actions">
                      <button
                        type="button"
                        class="secondary"
                        onclick={cancelRelate}
                        disabled={pickerBusy}
                      >Cancel</button>
                    </div>
                  </div>
                {/if}
                <div class="memory-similar">
                  <button
                    type="button"
                    class="memory-similar-toggle"
                    aria-expanded={similarOpen}
                    onclick={toggleSimilar}
                  >
                    <span class="memory-similar-caret" class:is-open={similarOpen}>
                      &#9656;
                    </span>
                    Similar memories
                  </button>
                  {#if similarOpen}
                    <div class="memory-similar-body">
                      {#if similarState.kind === 'loading'}
                        <p class="subtle memory-similar-loading">Loading…</p>
                      {:else if similarState.kind === 'error'}
                        <p class="error memory-similar-error">
                          Couldn't load similar memories - {similarState.message}
                        </p>
                      {:else if similarState.kind === 'loaded'}
                        {#if similarState.rows.length === 0}
                          <p class="subtle memory-similar-empty">
                            No similar memories found.
                          </p>
                        {:else}
                          <ul class="memory-similar-list">
                            {#each similarState.rows as row (row.id)}
                              <li class="memory-similar-row">
                                <span
                                  class="memory-similar-score"
                                  title="Match score"
                                >{row.similarity.toFixed(3)}</span>
                                <button
                                  type="button"
                                  class="memory-similar-link"
                                  onclick={() => openSimilar(row)}
                                >{row.label}</button>
                              </li>
                            {/each}
                          </ul>
                        {/if}
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
        </li>
      </ul>
    {/if}
  </div>
</section>

<style>
  /* Inline panel - mounted in the chat shell's main column when the
     Memories drawer tab is active. Mirrors the shape of Cookbook /
     Journal panels: full-height scroll, padding-only chrome, no
     header (the chat shell's top-bar owns the title slot). */
  .memories-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .memories-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    min-width: 0;
    flex: 1;
  }

  .memories-empty {
    margin: 1rem 0;
  }

  /* Memory librarian progress strip - renders at the top of the
     panel during a manual run and through the result handoff. Same
     visual language the wiki librarian uses. The strip sits above
     the memory list inside .memories-body so it scrolls with the
     content rather than pinning to the top. */
  .librarian-strip {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-subtle);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    max-width: 52rem;
  }

  .librarian-strip-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .librarian-strip-close {
    font-size: 0.85rem;
  }

  .librarian-confirm-desc {
    margin: 0 0 0.75rem 0;
    color: var(--text-subtle);
    font-size: 0.95rem;
  }

  .librarian-confirm-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .librarian-steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .librarian-step {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .librarian-step-icon {
    flex: 0 0 1rem;
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
  }

  .librarian-step-ok .librarian-step-icon {
    color: var(--accent);
  }

  .librarian-step-error .librarian-step-icon {
    color: var(--text-error);
  }

  .librarian-step-pending .librarian-step-icon {
    /* The "…" glyph reads as in-flight; subtle pulse keeps the user
       reassured the run hasn't hung. Animation is one of the few
       places a small reactive cue beats a static glyph. */
    animation: librarian-pulse 1.4s ease-in-out infinite;
  }

  @keyframes librarian-pulse {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 1; }
  }

  /* "Running in the background" notice in the confirm strip when a pass
     is in flight that this tab didn't start. Reuses the pending pulse so
     the in-flight cue matches the progress strip's. */
  .librarian-inflight {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0 0.5rem 0;
  }
  .librarian-inflight-spinner {
    animation: librarian-pulse 1.4s ease-in-out infinite;
  }

  .librarian-result-line {
    margin: 0.5rem 0 0 0;
    font-weight: 600;
  }

  .librarian-result-text {
    margin: 0.25rem 0 0 0;
    color: var(--text-subtle);
    font-size: 0.95rem;
  }

  .librarian-error {
    margin-top: 0.5rem;
  }

  .memory-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    /* Cap the body width so memory cards don't stretch into a
       hard-to-scan single-line ribbon on a wide viewport. The sidebar
       list is already narrow, so the panel-side cards are the place
       where a reading-width cap matters. */
    max-width: 52rem;
  }

  .memory-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.75rem 0.9rem;
  }

  .memory-header-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.35rem;
  }

  .memory-card-label {
    font-weight: 600;
    font-size: 0.95rem;
    /* Let long labels wrap rather than truncating - a truncated
       label is hostile when the whole point is that the user is
       here to read what's stored. */
    word-break: break-word;
  }

  .memory-card-meta {
    flex: 0 0 auto;
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .memory-card-data {
    margin: 0 0 0.6rem;
    font-size: 0.9rem;
    /* Match the prose leading the rest of the app uses for read-side
       content (wiki 1.6, journal 1.75, chat 1.45). Without an explicit
       value memory bodies inherit the browser default ~1.2 and read
       noticeably cramped next to every other card-rendered surface. */
    line-height: 1.6;
    color: var(--text);
    word-wrap: break-word;
    /* The reader-content text-shadow thickener is applied globally in
       src/styles.css (see "Main-section reader-content thickener"), not
       here, so all main-section content shares one weight step. */
  }
  /* The wrapper owns the bottom margin between the body and the
     relations / actions row, so collapse the margins on the
     paragraphs the Markdown component emits to avoid a doubled gap
     above the next block. */
  .memory-card-data :global(p:first-child) {
    margin-top: 0;
  }
  .memory-card-data :global(p:last-child) {
    margin-bottom: 0;
  }
  /* Boost the memory body prose a notch on desktop, mirroring the chat
     bubbles and composer textarea (both 1.05rem behind this same
     min-width:721px query - see src/styles.css). The desktop root is
     13.5px and at the card's default 0.9rem this read-side content reads
     small in the roomy panel; phones keep the 0.9rem since they inherit
     the larger 15.5px mobile root (see the @media (max-width: 720px)
     :root rule). Only the body data moves - the label is heading-like
     and holds its rem-anchored size, same as chat headings. */
  @media (min-width: 721px) {
    .memory-card-data {
      font-size: 1.05rem;
    }
  }

  .memory-card-actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .memory-delete-prompt {
    font-size: 0.85rem;
    margin-right: 0.25rem;
  }

  .memory-delete-message {
    flex: 1 1 14rem;
    min-width: 10rem;
  }

  /* Busy state for the action buttons (Reaffirm / Doubt / confirmed
     Delete). The disabled attribute already greys + uncursors the
     button; this layer adds a "live" cue - a soft accent-weak fill
     so the active button reads as the one mid-flight, distinct from
     the sibling buttons that disabled at the same time but are NOT
     the one doing work. progress cursor over the box reinforces the
     "wait, this is running" read. */
  .memory-card-actions button.is-busy {
    background: var(--accent-weak);
    color: var(--text);
    cursor: progress;
    /* The disabled attribute on the busy button itself would drop
       opacity, hiding the accent-weak fill. Counter-act so the
       in-flight button visibly differs from the inert siblings. */
    opacity: 1;
  }
  /* Danger-flavoured variant for the confirmed-Delete button so the
     busy state stays red rather than swapping to the accent palette
     mid-call. Same idea as `.tag-shaky` borrowing `--danger`. */
  .memory-card-actions button.danger.is-busy {
    background: color-mix(in srgb, var(--danger) 55%, transparent);
    color: var(--ink-on-danger);
  }

  /* Per-action status pulse rendered inside the actions row. Mirrors
     the size and tone of `.memory-save-state` in the edit form so
     the two surfaces share a visual vocabulary. */
  .memory-action-state {
    font-size: 0.8rem;
    margin-left: 0.25rem;
    line-height: 1.1;
  }
  .memory-action-state.action-ok {
    color: var(--ok);
  }

  .memory-edit .form-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .memory-edit label {
    font-size: 0.8rem;
    color: var(--muted);
  }

  .memory-edit input,
  .memory-edit textarea {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.55rem;
    font: inherit;
    width: 100%;
  }

  .memory-data-edit {
    min-height: 6rem;
    resize: vertical;
    font-family: inherit;
  }

  .char-count {
    font-size: 0.75rem;
    align-self: flex-end;
  }

  .memory-edit-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.35rem;
  }

  .memory-save-state {
    font-size: 0.8rem;
    min-height: 1.1rem;
    flex: 1;
    min-width: 0;
  }

  /* Green-ish cue for the 'Saved' badge so it reads as success at a
     glance without needing a color swatch in the neutral palette. */
  .save-ok {
    color: var(--accent);
  }

  .memory-edit-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  /* `button.danger` is styled globally in styles.css - no local
     override needed. The confirmed-delete button picks up the red
     fill and ink-on-danger text color from there. */

  /* Confidence indicators. The three tags (corroborated / hedged /
     shaky) are the meaningful cases; neutral memories get a quiet
     numeric chip instead so the user can still see the raw value. The
     tag colours are restrained - this is diagnostic chrome, not a
     headline element. */
  .memory-confidence-tag,
  .memory-confidence-chip {
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    line-height: 1;
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .memory-confidence-tag {
    text-transform: lowercase;
    font-weight: 500;
  }

  .tag-corroborated {
    background: var(--accent-bg, var(--bg-2));
    border-color: var(--accent, var(--border));
    color: var(--accent, var(--text));
  }

  .tag-hedged {
    background: var(--bg-2);
    color: var(--muted);
  }

  .tag-shaky {
    background: var(--bg-2);
    color: var(--muted);
    border-style: dashed;
  }

  /* Relation list rendered under the memory body. Each row is one
     outbound edge: kind label, optional confidence tag on the target,
     the target's label, optional note, and a remove button. */
  /* Scoped to the current memory (relationError.memoryId === m.id);
     sits just above the relations list so a failure on one of the
     listed edges reads next to the rows it concerns. Same visual
     weight as the global .error helper. */
  .memory-relation-error {
    margin: 0.4rem 0 0;
    font-size: 0.85rem;
  }

  .memory-relations {
    list-style: none;
    margin: 0 0 0.6rem;
    padding: 0.4rem 0 0;
    border-top: 1px dashed var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .memory-relation {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.82rem;
    flex-wrap: wrap;
  }

  .memory-relation-kind {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius);
    background: var(--bg-2);
    color: var(--muted);
    flex: 0 0 auto;
  }

  /* Keep contradicts visually distinct - it's the one relation where
     drawing the edge means the source and target actively disagree. A
     faint red tint makes it scan differently from the supporting /
     generalising ones without shouting. */
  .kind-contradicts {
    background: var(--danger-bg, var(--bg-2));
    color: var(--danger, var(--muted));
  }

  .memory-relation-label {
    font-weight: 500;
    word-break: break-word;
  }

  .memory-relation-note {
    font-size: 0.8rem;
    word-break: break-word;
    flex: 1 1 12rem;
  }

  .memory-relation-remove {
    background: transparent;
    color: var(--muted);
    border: none;
    padding: 0 0.25rem;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
    margin-left: auto;
  }

  .memory-relation-remove:hover {
    color: var(--danger, var(--text));
  }

  /* Inline picker for the + Relate action. Same vertical flow as the
     edit form so the two share a visual vocabulary. */
  .memory-relate-picker {
    margin-top: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .memory-relate-picker .form-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .memory-relate-picker label {
    font-size: 0.8rem;
    color: var(--muted);
  }

  .memory-relate-picker input,
  .memory-relate-picker select {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.35rem 0.5rem;
    font: inherit;
    width: 100%;
  }

  .memory-relate-candidates {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 10rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .memory-relate-candidate {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    padding: 0.35rem 0.5rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    font: inherit;
    flex-wrap: wrap;
  }

  .memory-relate-candidate:hover:not(:disabled) {
    background: var(--bg-2);
  }

  .memory-relate-candidate:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .memory-relate-candidate-label {
    font-weight: 500;
    word-break: break-word;
  }

  .memory-relate-candidate-data {
    font-size: 0.8rem;
    flex: 1 1 12rem;
    /* Elide long candidate bodies so the picker stays scannable - the
       user is choosing a target by label, not reading full memories. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .memory-relate-empty {
    margin: 0.25rem 0;
    font-size: 0.85rem;
  }

  /* Similar-memories disclosure - sits at the foot of the card. Top
     border separates it from the action row above so the collapsed
     toggle reads as its own zone rather than another action. */
  .memory-similar {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-subtle);
  }

  .memory-similar-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-subtle);
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }

  .memory-similar-toggle:hover {
    color: var(--text);
  }

  .memory-similar-caret {
    display: inline-block;
    font-size: 0.7rem;
    transition: transform 0.15s ease;
  }

  .memory-similar-caret.is-open {
    transform: rotate(90deg);
  }

  .memory-similar-body {
    margin-top: 0.6rem;
  }

  .memory-similar-loading {
    margin: 0.25rem 0;
    /* Reuse the librarian pulse so the "Loading" cue reads as in-flight
       rather than a static label while the neighbour fetch runs. */
    animation: librarian-pulse 1.4s ease-in-out infinite;
  }

  .memory-similar-error,
  .memory-similar-empty {
    margin: 0.25rem 0;
    font-size: 0.9rem;
  }

  .memory-similar-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .memory-similar-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  /* Match-score pill. tabular-nums keeps the fixed 0.000 format from
     jittering as digit widths change down the list, so the pills stack
     in a clean column to the left of the labels. */
  .memory-similar-score {
    flex: none;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-md);
    background: var(--bg-2);
    color: var(--muted);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }

  .memory-similar-link {
    padding: 0;
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.95rem;
    text-align: left;
    cursor: pointer;
  }

  .memory-similar-link:hover {
    text-decoration: underline;
  }
</style>
