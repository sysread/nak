<script lang="ts">
  /*
   * Memories modal. Reached from the Memories icon in the chat drawer
   * footer (between Help and Settings) and from a "Browse memories"
   * link inside the AI settings pane.
   *
   * The modal is the first human-facing surface on the memories table —
   * everything else is assistant-driven. Users can:
   *   - browse every memory the account has accumulated
   *   - search semantically (same pipeline as the `memory_search` tool
   *     via the shared helper in `src/lib/memories.ts`; falls back to
   *     ILIKE if Venice is unreachable or unconfigured)
   *   - edit label/data inline with clear save-state feedback
   *   - delete memories outright (hard delete; distinct from the
   *     assistant's `memory_invalidate` soft-delete)
   *
   * Chrome mirrors Help.svelte (single scrolling column) rather than
   * Settings.svelte (two-column nav) because there are no panes — just
   * one list. CSS classes are parallel (`.memories-shell` etc.) rather
   * than shared with Help/Settings so each modal can evolve without
   * dragging the others along.
   */
  import { app } from '$lib/state.svelte';
  import { searchMemoriesSemantic } from '$lib/memories';
  import { MAX_MEMORY_DATA_CHARS } from '$lib/embeddings/types';
  import type { Memory } from '$lib/supabase';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  // Label length is capped at 80 by the memory_create/update tool
  // schemas; mirror it here so the UI rejects early instead of
  // bouncing off a Supabase error. Data length is capped at
  // MAX_MEMORY_DATA_CHARS (imported).
  const MAX_LABEL_CHARS = 80;

  // Keep the initial page size generous enough that a typical account
  // ("distilled notes, a handful per month") fits without pagination.
  // The assistant tool tops out at 100 per call too — matching caps
  // means the human UI never hides rows the assistant can reach.
  const LIST_LIMIT = 100;

  // Debounce keystrokes before firing a search so rapid typing doesn't
  // fire one embedding request per character. 200ms is short enough
  // that intent-to-result feels snappy and long enough that it kicks
  // in once the user has stopped.
  const SEARCH_DEBOUNCE_MS = 200;

  let query = $state('');
  let results = $state<Memory[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Which row (if any) is currently in edit mode. Only one row edits
  // at a time — simplifies the "unsaved changes" semantics and stops
  // the user from silently losing an edit by clicking Edit on a
  // second row.
  let editingId = $state<string | null>(null);
  let editLabel = $state('');
  let editData = $state('');
  // Three-state save indicator, mirroring the pattern in Settings'
  // system-prompts pane (see Settings.svelte line 109). The goal is
  // that the user never has to guess whether their edit is live —
  // every state transition is visible.
  type SaveState =
    | { kind: 'idle' }
    | { kind: 'dirty' } // draft differs from server row
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string };
  let saveState = $state<SaveState>({ kind: 'idle' });

  // Delete confirmation — one row at a time, same reasoning as edits.
  let deletingId = $state<string | null>(null);
  // Surfaces a delete failure inline next to the targeted row rather
  // than in the global error banner, so the user sees it in context.
  let deleteError = $state<string | null>(null);

  // Most recent search AbortController, so rapid retyping cancels any
  // in-flight embedding request before firing a fresh one. Stored at
  // module scope (not inside the effect) so the debounce timer can
  // reach it too.
  let currentAbort: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function runSearch(q: string): Promise<void> {
    if (!app.supabase) {
      error = 'Not connected to Supabase yet.';
      loading = false;
      return;
    }
    // Cancel any in-flight request so its late arrival doesn't clobber
    // the fresh result.
    if (currentAbort) currentAbort.abort();
    const ctl = new AbortController();
    currentAbort = ctl;
    loading = true;
    error = null;
    try {
      const hits = await searchMemoriesSemantic(q, LIST_LIMIT, {
        supabase: app.supabase,
        venice: app.venice,
        signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      results = hits;
    } catch (err) {
      if (ctl.signal.aborted) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (currentAbort === ctl) currentAbort = null;
      if (!ctl.signal.aborted) loading = false;
    }
  }

  // Initial load + re-run on query change (debounced). We can't use a
  // straight `$effect` because we want a debounce window, and we need
  // to cancel the previous timer cleanly when the user keeps typing.
  $effect(() => {
    const q = query.trim();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
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

  function startEdit(m: Memory): void {
    editingId = m.id;
    editLabel = m.label;
    editData = m.data;
    saveState = { kind: 'idle' };
    // Cancel any pending delete confirmation when the user pivots to
    // edit mode — two open prompts at once is confusing.
    deletingId = null;
    deleteError = null;
  }

  function cancelEdit(): void {
    // Disallow cancel mid-save — the Supabase write is already in
    // flight; walking away here would leave the UI and the row
    // out-of-sync on success. Users can wait the ~200ms.
    if (saveState.kind === 'saving') return;
    editingId = null;
    editLabel = '';
    editData = '';
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
    if (!label) {
      saveState = { kind: 'error', message: 'Label is required.' };
      return;
    }
    if (label.length > MAX_LABEL_CHARS) {
      saveState = { kind: 'error', message: `Label must be ${MAX_LABEL_CHARS} chars or fewer.` };
      return;
    }
    if (!data) {
      saveState = { kind: 'error', message: 'Data is required.' };
      return;
    }
    if (data.length > MAX_MEMORY_DATA_CHARS) {
      saveState = {
        kind: 'error',
        message: `Data must be ${MAX_MEMORY_DATA_CHARS} chars or fewer.`,
      };
      return;
    }
    saveState = { kind: 'saving' };
    try {
      const updated = await app.supabase.updateMemory(id, { label, data });
      // Replace the row in-place so the list doesn't visually reorder
      // mid-edit. The updated_at bump is reflected on next re-search;
      // not re-querying here keeps the edit affordance stable (the
      // row we just saved stays where it was).
      results = results.map((m) => (m.id === id ? updated : m));
      saveState = { kind: 'saved' };
    } catch (err) {
      saveState = {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Track dirty state while editing so the "Unsaved changes" label
  // appears the moment the user diverges from the row on the server.
  // We only compare when an edit is actually open — otherwise the
  // effect would thrash on every result-list refresh.
  $effect(() => {
    if (!editingId) return;
    const original = results.find((m) => m.id === editingId);
    if (!original) return;
    // Don't demote 'saving' or 'error' into 'dirty' — those states
    // are informational and should linger until the user responds.
    if (saveState.kind === 'saving' || saveState.kind === 'error') return;
    const diverged = editLabel !== original.label || editData !== original.data;
    if (diverged) {
      if (saveState.kind !== 'dirty') saveState = { kind: 'dirty' };
    } else {
      // Back to matching the server row. Collapse 'saved' too — the
      // badge was confirming a prior save; once the fields match the
      // stored row again there's nothing pending to report.
      if (saveState.kind !== 'idle') saveState = { kind: 'idle' };
    }
  });

  function requestDelete(m: Memory): void {
    deletingId = m.id;
    deleteError = null;
    // Cancel an open edit on a different row — we don't want an inline
    // editor and a delete-confirm strip both visible at the same time.
    if (editingId && editingId !== m.id) cancelEdit();
  }

  function cancelDelete(): void {
    deletingId = null;
    deleteError = null;
  }

  async function confirmDelete(): Promise<void> {
    if (!deletingId || !app.supabase) return;
    const id = deletingId;
    try {
      await app.supabase.deleteMemory(id);
      results = results.filter((m) => m.id !== id);
      // If the deleted row was also the one being edited (e.g. the
      // user hit Delete from inside the editor), tear the editor
      // down so it can't reference a row that no longer exists.
      if (editingId === id) {
        editingId = null;
        editLabel = '';
        editData = '';
        saveState = { kind: 'idle' };
      }
      deletingId = null;
      deleteError = null;
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err);
    }
  }

  // Human-friendly "N minutes ago" for the updated_at timestamp. Cheap
  // inline implementation — the thread list uses a similar helper, but
  // pulling it in would drag along thread-specific formatting. Small
  // enough to inline here without becoming a shared util.
  function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diffSec = Math.round((Date.now() - then) / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hr ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
    const diffWk = Math.round(diffDay / 7);
    if (diffWk < 5) return `${diffWk} wk ago`;
    const diffMo = Math.round(diffDay / 30);
    if (diffMo < 12) return `${diffMo} mo ago`;
    const diffYr = Math.round(diffDay / 365);
    return `${diffYr} yr${diffYr === 1 ? '' : 's'} ago`;
  }
</script>

<!--
  Escape and click-outside both dismiss. The outer `.center` is the
  backdrop — only close when the target IS the backdrop itself, so
  clicks inside `.memories-shell` (search input, row buttons,
  edit fields) don't trigger a spurious close. Mirrors Settings/Help.
-->
<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center memories-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="memories-shell" role="dialog" aria-modal="true" aria-label="Memories">
    <button
      type="button"
      class="memories-close"
      onclick={onClose}
      aria-label="Close memories"
      title="Close"
    >×</button>

    <header class="memories-header">
      <h1 class="memories-title">Memories</h1>
      <p class="subtle memories-blurb">
        Everything Nak has remembered about you. Search by meaning
        (synonyms and paraphrases work), edit, or delete any row.
      </p>
      <div class="memories-search">
        <label class="sr-only" for="memories-search-input">Search memories</label>
        <input
          id="memories-search-input"
          type="search"
          placeholder="Search memories…"
          bind:value={query}
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    </header>

    <section class="memories-body">
      {#if error}
        <p class="error">{error}</p>
      {/if}

      {#if loading && results.length === 0}
        <p class="subtle">Loading memories…</p>
      {:else if results.length === 0}
        {#if query.trim().length > 0}
          <p class="subtle memories-empty">
            No memories match "{query.trim()}".
          </p>
        {:else}
          <p class="subtle memories-empty">
            Nothing here yet. Memories accumulate as you chat — see
            the Help modal's Memory page for details.
          </p>
        {/if}
      {:else}
        <ul class="memory-list">
          {#each results as m (m.id)}
            <li class="memory-card">
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
                  <div class="memory-edit-footer">
                    <div class="memory-save-state" aria-live="polite">
                      {#if saveState.kind === 'dirty'}
                        <span class="subtle">Unsaved changes</span>
                      {:else if saveState.kind === 'saving'}
                        <span class="subtle">Saving…</span>
                      {:else if saveState.kind === 'saved'}
                        <span class="subtle save-ok">Saved ✓</span>
                      {:else if saveState.kind === 'error'}
                        <span class="error">Couldn't save — {saveState.message}</span>
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
                    <span class="subtle memory-card-meta" title={m.updated_at}>
                      {relativeTime(m.updated_at)}
                    </span>
                  </div>
                  <p class="memory-card-data">{m.data}</p>
                  <div class="memory-card-actions">
                    <button
                      type="button"
                      class="secondary"
                      onclick={() => startEdit(m)}
                    >Edit</button>
                    {#if deletingId === m.id}
                      <span class="subtle memory-delete-prompt">Really delete?</span>
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
                        onclick={() => requestDelete(m)}
                      >Delete</button>
                    {/if}
                  </div>
                  {#if deletingId === m.id && deleteError}
                    <p class="error">{deleteError}</p>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  /* Parallel to .help-shell / .settings-shell. Single scrolling
     column like Help (no side-nav), but with a fixed header block
     that hosts the title, blurb, and search input. */
  .memories-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 100%;
    max-width: 52rem;
    display: grid;
    grid-template-rows: auto 1fr;
    height: min(40rem, 85vh);
    overflow: hidden;
  }

  /* Close button duplicates .settings-close / .help-close deliberately
     — the three modals stay visually lockstep but can evolve
     independently. Same reasoning as the existing files. */
  .memories-close {
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

  .memories-close:hover {
    background: var(--bg-2);
  }

  .memories-header {
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    /* Reserve the close button's column so a long title can't overlap
       it on narrow widths. */
    padding-right: 3rem;
  }

  .memories-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
  }

  .memories-blurb {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
  }

  .memories-search input {
    width: 100%;
    padding: 0.45rem 0.6rem;
    font-size: 0.9rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .memories-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    min-width: 0;
  }

  .memories-empty {
    margin: 1rem 0;
  }

  .memory-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
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
    /* Let long labels wrap rather than truncating — a truncated
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
    color: var(--text);
    /* Preserve paragraph breaks the reflection agent writes, but
       still let long words wrap. */
    white-space: pre-wrap;
    word-wrap: break-word;
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

  /* `button.danger` is styled globally in styles.css — no local
     override needed. The confirmed-delete button picks up the red
     fill and ink-on-danger text color from there. */
</style>
