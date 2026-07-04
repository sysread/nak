<script lang="ts">
  /*
   * Sidebar listing for the Artifacts tab - every live attachment the user
   * has across all conversations, for review and cleanup. Shown in the left
   * drawer when the Artifacts tab is active.
   *
   * Owns the filename search (bound to `artifactStore.query`), the kind
   * filter (all / images / files), and the sort (newest / largest). Image
   * rows get a thumbnail resolved via a batched signed-URL call. Clicking a
   * row jumps to the conversation the file lives in; the trash button marks
   * the attachment expired (it then re-renders as the greyed placeholder in
   * that conversation) and drops it from this list.
   */
  import { app } from '$lib/state.svelte';
  import { navigate } from '$lib/routing.svelte';
  import { formatBytes } from '$lib/attachments';
  import type { ArtifactListRow } from '$lib/supabase';
  import {
    artifactStore,
    loadArtifactsFirstPage,
    loadMoreArtifacts,
    removeArtifactRow,
    type ArtifactKind,
    type ArtifactSort,
  } from '$lib/artifacts-store.svelte';
  import {
    ARTIFACTS_SEARCH_DEBOUNCE_MS,
    ARTIFACT_KIND_OPTIONS,
    ARTIFACT_SORT_OPTIONS,
    artifactsScannerLabel,
    artifactsEmptyMessage,
    isImageArtifact,
  } from '$lib/ui/artifacts-list';
  import { infiniteScroll } from '$lib/actions/infinite-scroll';
  import Scanner from './Scanner.svelte';

  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // attachment id -> signed thumbnail URL, for image rows only.
  let thumbs = $state<Map<string, string>>(new Map());
  // ids with a delete in flight, to disable their trash button.
  let deleting = $state<Set<string>>(new Set());

  // Reload (debounced) on every filename keystroke.
  $effect(() => {
    const _q = artifactStore.query;
    void _q;
    if (!app.supabase) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (app.supabase) void loadArtifactsFirstPage(app.supabase);
    }, ARTIFACTS_SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  // Resolve thumbnails for the image rows whenever the result set changes.
  // Batched into one Storage call; non-image rows are skipped.
  $effect(() => {
    const rows = artifactStore.results.filter((r) => isImageArtifact(r));
    if (!app.supabase || rows.length === 0) {
      thumbs = new Map();
      return;
    }
    let cancelled = false;
    void app.supabase
      .createAttachmentSignedUrls(rows.map((r) => ({ id: r.id, storage_path: r.storage_path })))
      .then((m) => {
        if (!cancelled) thumbs = m;
      })
      .catch(() => {
        // A failed thumbnail batch is non-fatal: rows fall back to the file
        // glyph. The list itself still loaded.
        if (!cancelled) thumbs = new Map();
      });
    return () => {
      cancelled = true;
    };
  });

  function setKind(kind: ArtifactKind): void {
    if (artifactStore.kind === kind) return;
    artifactStore.kind = kind;
    if (app.supabase) void loadArtifactsFirstPage(app.supabase);
  }

  function setSort(sort: ArtifactSort): void {
    if (artifactStore.sort === sort) return;
    artifactStore.sort = sort;
    if (app.supabase) void loadArtifactsFirstPage(app.supabase);
  }

  function pickArtifact(row: ArtifactListRow): void {
    navigate({ cid: row.thread_id, drawer: null });
    onSelect?.();
  }

  async function deleteArtifact(row: ArtifactListRow): Promise<void> {
    if (!app.supabase || deleting.has(row.id)) return;
    if (
      !confirm(
        `Delete "${row.filename}"? It will be removed from "${row.thread_title}" and freed from storage. This can't be undone.`
      )
    ) {
      return;
    }
    deleting = new Set(deleting).add(row.id);
    try {
      await app.supabase.deleteAttachment(row.id);
      removeArtifactRow(row.id);
    } catch (err) {
      artifactStore.error = err instanceof Error ? err.message : String(err);
    } finally {
      const next = new Set(deleting);
      next.delete(row.id);
      deleting = next;
    }
  }
</script>

<div class="recipe-drawer-list">
  <div class="artifacts-controls">
    <input
      type="search"
      name="artifacts-search"
      class="sidebar-search-input"
      placeholder="Search files"
      aria-label="Search files"
      bind:value={artifactStore.query}
      autocomplete="off"
      spellcheck="false"
    />
    <div class="artifacts-filter-row">
      <div class="artifacts-segmented" role="group" aria-label="Filter by type">
        {#each ARTIFACT_KIND_OPTIONS as opt (opt.value)}
          <button
            type="button"
            class="artifacts-seg-btn"
            class:active={artifactStore.kind === opt.value}
            aria-pressed={artifactStore.kind === opt.value}
            onclick={() => setKind(opt.value)}
          >{opt.label}</button>
        {/each}
      </div>
      <div class="artifacts-segmented" role="group" aria-label="Sort order">
        {#each ARTIFACT_SORT_OPTIONS as opt (opt.value)}
          <button
            type="button"
            class="artifacts-seg-btn"
            class:active={artifactStore.sort === opt.value}
            aria-pressed={artifactStore.sort === opt.value}
            onclick={() => setSort(opt.value)}
          >{opt.label}</button>
        {/each}
      </div>
    </div>
  </div>

  {#if artifactStore.loading}
    <div class="search-status">
      <Scanner label={artifactsScannerLabel(artifactStore.query)} size={0.9} />
    </div>
  {:else if artifactStore.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load files: {artifactStore.error}
    </p>
  {:else if artifactStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {artifactsEmptyMessage(artifactStore.query, artifactStore.kind)}
    </p>
  {:else}
    {#each artifactStore.results as row (row.id)}
      <div class="row thread-row artifact-row">
        <button
          type="button"
          class="thread grow artifact-main"
          onclick={() => pickArtifact(row)}
          title={`${row.filename} - in "${row.thread_title}"`}
        >
          {#if isImageArtifact(row) && thumbs.get(row.id)}
            <img class="artifact-thumb" src={thumbs.get(row.id)} alt="" loading="lazy" />
          {:else}
            <span class="artifact-thumb artifact-thumb-file" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 3v5h5" />
                <path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
              </svg>
            </span>
          {/if}
          <span class="artifact-meta">
            <span class="artifact-filename">{row.filename}</span>
            <span class="artifact-submeta">
              <span class="artifact-thread">{row.thread_title}</span>
              <span class="artifact-size">{formatBytes(row.size_bytes)}</span>
            </span>
          </span>
        </button>
        <button
          type="button"
          class="artifact-delete"
          aria-label={`Delete ${row.filename}`}
          title="Delete file"
          disabled={deleting.has(row.id)}
          onclick={() => deleteArtifact(row)}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18" />
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
          </svg>
        </button>
      </div>
    {/each}

    {#if artifactStore.hasMore}
      <div
        class="artifacts-list-sentinel"
        use:infiniteScroll={{ onHit: () => app.supabase && loadMoreArtifacts(app.supabase) }}
        aria-hidden="true"
      >
        {#if artifactStore.loadingMore}
          <Scanner label="Loading more files" size={0.85} />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .artifacts-controls {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.4rem;
  }
  .artifacts-controls .sidebar-search-input {
    width: 100%;
    min-width: 0;
  }
  .artifacts-filter-row {
    display: flex;
    justify-content: space-between;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  /* Segmented pill group - the active option is filled, the rest are quiet,
     so the current filter/sort reads at a glance in the narrow drawer. */
  .artifacts-segmented {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }
  .artifacts-seg-btn {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0.15rem 0.55rem;
    font-size: 0.72rem;
    color: var(--muted);
    cursor: pointer;
  }
  .artifacts-seg-btn:hover {
    color: var(--text);
  }
  .artifacts-seg-btn.active {
    background: var(--accent-soft, var(--bg-1));
    color: var(--text);
    font-weight: 600;
  }
  /* The row pairs a navigate-to-conversation button with a trailing delete
     button (siblings, not nested - a button can't contain a button). */
  .artifact-row {
    display: flex;
    align-items: stretch;
    gap: 0.15rem;
  }
  .artifact-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    text-align: left;
  }
  .artifact-thumb {
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-md);
    object-fit: cover;
    flex-shrink: 0;
    background: var(--bg-1);
  }
  .artifact-thumb-file {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .artifact-meta {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .artifact-filename {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .artifact-submeta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
    opacity: 0.6;
    min-width: 0;
  }
  .artifact-thread {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .artifact-size {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .artifact-delete {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2rem;
    background: transparent;
    border: 0;
    border-radius: var(--radius-md);
    color: var(--muted);
    cursor: pointer;
  }
  .artifact-delete:hover:not(:disabled),
  .artifact-delete:focus-visible:not(:disabled) {
    color: var(--danger, #c0392b);
    background: var(--bg-1);
  }
  .artifact-delete:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .artifacts-list-sentinel {
    min-height: 1px;
    padding: 0.5rem 0;
  }
</style>
