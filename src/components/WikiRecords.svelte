<script lang="ts">
  /*
   * Records section, rendered at the bottom of a wiki article view in
   * Wiki.svelte. Records are dated entries linked to the article: the
   * topic's journey (events, experiments, observations), distinct from
   * the article body's consolidated "current state".
   *
   * This component owns the records list, its filters (date range + tag),
   * a cross-article semantic search, the per-record expand/collapse, and
   * the inline compose/edit form. All decision logic (date formatting,
   * previews, tag parse/serialize, pluralized headline, empty-state copy,
   * tag collection) lives in $lib/ui/wiki-records.ts; this file is the
   * Svelte glue.
   *
   * Data refresh: the load effect refetches on articleId change and on
   * the onWikiRecordChange bus (in-app writes fire it directly; the
   * wiki_records realtime subscription relays server-side writes from the
   * extraction agent / librarian / chat record tools through the same
   * bus - see Chat.svelte).
   */
  import { app } from '$lib/state.svelte';
  import { searchWikiRecordsSemantic, MAX_WIKI_RECORD_CONTENT_CHARS } from '$lib/wiki';
  import type { WikiArticle, WikiRecord } from '$lib/supabase';
  import { downloadRecordMarkdown, downloadArticleZip } from '$lib/wiki-export';
  import { emitWikiRecordChange, onWikiRecordChange } from '$lib/wiki-events';
  import {
    formatRecordDate,
    contentPreview,
    parseTags,
    serializeTags,
    recordsHeadline,
    recordsEmptyMessage,
    collectTags,
    todayIso,
  } from '$lib/ui/wiki-records';
  import Markdown from './Markdown.svelte';

  interface Props {
    article: WikiArticle;
  }
  const { article }: Props = $props();
  const articleId = $derived(article.id);

  // --- list + filter state ---------------------------------------------
  let records = $state<WikiRecord[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let fromDate = $state('');
  let toDate = $state('');
  let tagFilter = $state('');

  // --- semantic search state -------------------------------------------
  // Search is cross-article by design (the record_search tool's twin), so
  // a hit may belong to a different article; the row notes that.
  let searchQuery = $state('');
  let searchResults = $state<WikiRecord[] | null>(null);
  let searching = $state(false);

  // --- expand/collapse -------------------------------------------------
  let expandedId = $state<string | null>(null);

  // --- compose / edit form ---------------------------------------------
  let composing = $state(false);
  let editingId = $state<string | null>(null);
  let formDate = $state('');
  let formContent = $state('');
  let formTags = $state('');
  let formBusy = $state(false);
  let formError = $state<string | null>(null);

  const availableTags = $derived(collectTags(records));

  // The list the UI renders: search results when a search is active,
  // otherwise the filtered article records. Filtering happens server-side
  // (listWikiRecords), so `records` is already filtered; search results
  // bypass the article/date/tag filters by design.
  const visible = $derived(searchResults ?? records);

  async function load(): Promise<void> {
    if (!app.supabase || !articleId) return;
    loading = true;
    loadError = null;
    try {
      records = await app.supabase.listWikiRecords(articleId, {
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        tags: tagFilter ? [tagFilter] : undefined,
      });
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load records.';
    } finally {
      loading = false;
    }
  }

  // Reload on article change or any record write. Filters are read inside
  // load(); changing a filter calls load() directly (below) rather than
  // through this effect so a keystroke in the date field doesn't refetch
  // mid-type via reactivity.
  $effect(() => {
    void articleId;
    void load();
    const off = onWikiRecordChange(() => void load());
    return () => off();
  });

  async function runSearch(): Promise<void> {
    if (!app.supabase) return;
    const q = searchQuery.trim();
    if (!q) {
      searchResults = null;
      return;
    }
    searching = true;
    try {
      searchResults = await searchWikiRecordsSemantic(q, 20, { supabase: app.supabase });
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Search failed.';
      searchResults = [];
    } finally {
      searching = false;
    }
  }

  function clearSearch(): void {
    searchQuery = '';
    searchResults = null;
  }

  function startCompose(): void {
    composing = true;
    editingId = null;
    formDate = todayIso();
    formContent = '';
    formTags = '';
    formError = null;
  }

  function startEdit(record: WikiRecord): void {
    composing = true;
    editingId = record.id;
    formDate = record.date;
    formContent = record.content;
    formTags = serializeTags(record.tags);
    formError = null;
  }

  function cancelForm(): void {
    composing = false;
    editingId = null;
    formError = null;
  }

  async function saveForm(): Promise<void> {
    if (!app.supabase) return;
    const content = formContent.trim();
    if (!content) {
      formError = 'Content is required.';
      return;
    }
    if (content.length > MAX_WIKI_RECORD_CONTENT_CHARS) {
      formError = `Content must be ${MAX_WIKI_RECORD_CONTENT_CHARS} chars or fewer.`;
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(formDate)) {
      formError = 'Pick a valid date.';
      return;
    }
    formBusy = true;
    formError = null;
    const tags = parseTags(formTags);
    try {
      if (editingId) {
        await app.supabase.updateWikiRecord(editingId, { date: formDate, content, tags });
      } else {
        await app.supabase.createWikiRecord({ articleId, date: formDate, content, tags });
      }
      emitWikiRecordChange();
      composing = false;
      editingId = null;
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Failed to save record.';
    } finally {
      formBusy = false;
    }
  }

  async function deleteRecord(record: WikiRecord): Promise<void> {
    if (!app.supabase) return;
    if (!confirm('Delete this record? This cannot be undone.')) return;
    try {
      await app.supabase.deleteWikiRecord(record.id);
      emitWikiRecordChange();
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to delete record.';
    }
  }

  function toggleExpanded(id: string): void {
    expandedId = expandedId === id ? null : id;
  }
</script>

<section class="wiki-records" aria-label="Records">
  <header class="wiki-records-header">
    <h2>{recordsHeadline(searchResults ? searchResults.length : records.length)}</h2>
    <div class="wiki-records-header-actions">
      {#if records.length > 0}
        <!-- Exports this article's records (filters/search aside) plus the
             article body as a ZIP. Uses the unfiltered `records` rather
             than `visible` so a download is always the full set. -->
        <button type="button" onclick={() => downloadArticleZip(article, records)}>
          Export all
        </button>
      {/if}
      {#if !composing}
        <button type="button" class="primary" onclick={startCompose}>Add record</button>
      {/if}
    </div>
  </header>

  <!-- Cross-article semantic search. A hit may belong to another
       article; the row flags that so a click-through expectation is set. -->
  <div class="wiki-records-search form-row">
    <input
      type="search"
      placeholder="Search all records by meaning…"
      bind:value={searchQuery}
      onkeydown={(e) => {
        if (e.key === 'Enter') void runSearch();
      }}
    />
    <button type="button" onclick={() => void runSearch()} disabled={searching}>
      {searching ? 'Searching…' : 'Search'}
    </button>
    {#if searchResults}
      <button type="button" onclick={clearSearch}>Clear</button>
    {/if}
  </div>

  {#if !searchResults}
    <!-- Filters apply to this article's records only; a search bypasses
         them (it spans every article). -->
    <div class="wiki-records-filters">
      <label>
        From
        <input type="date" bind:value={fromDate} onchange={() => void load()} />
      </label>
      <label>
        To
        <input type="date" bind:value={toDate} onchange={() => void load()} />
      </label>
      <label>
        Tag
        <select bind:value={tagFilter} onchange={() => void load()}>
          <option value="">All</option>
          {#each availableTags as tag (tag)}
            <option value={tag}>{tag}</option>
          {/each}
        </select>
      </label>
    </div>
  {/if}

  {#if composing}
    <div class="wiki-records-compose">
      <h3>{editingId ? 'Edit record' : 'New record'}</h3>
      <div class="form-row">
        <label for="record-date">Date</label>
        <input id="record-date" type="date" bind:value={formDate} disabled={formBusy} />
      </div>
      <div class="form-row">
        <label for="record-content">Content (Markdown)</label>
        <textarea
          id="record-content"
          bind:value={formContent}
          maxlength={MAX_WIKI_RECORD_CONTENT_CHARS}
          disabled={formBusy}
          rows={8}
          spellcheck="true"
        ></textarea>
        <p class="subtle char-count">
          {formContent.length} / {MAX_WIKI_RECORD_CONTENT_CHARS}
        </p>
      </div>
      <div class="form-row">
        <label for="record-tags">Tags (comma-separated)</label>
        <input
          id="record-tags"
          type="text"
          bind:value={formTags}
          disabled={formBusy}
          placeholder="hydration, outcome, milestone"
          autocomplete="off"
        />
      </div>
      {#if formError}
        <p class="error">{formError}</p>
      {/if}
      <div class="row">
        <button type="button" class="primary" onclick={saveForm} disabled={formBusy}>
          {formBusy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onclick={cancelForm} disabled={formBusy}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if loadError}
    <p class="error">{loadError}</p>
  {/if}

  {#if loading}
    <p class="subtle">Loading records…</p>
  {:else if visible.length === 0}
    <p class="subtle">
      {recordsEmptyMessage({
        filtered: !!(fromDate || toDate || tagFilter),
        searching: !!searchResults,
      })}
    </p>
  {:else}
    <ul class="wiki-records-list">
      {#each visible as record (record.id)}
        <li class="wiki-record" class:expanded={expandedId === record.id}>
          <div
            class="wiki-record-row"
            role="button"
            tabindex="0"
            onclick={() => toggleExpanded(record.id)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleExpanded(record.id);
              }
            }}
          >
            <span class="wiki-record-date">{formatRecordDate(record.date)}</span>
            <span class="wiki-record-preview">
              {expandedId === record.id ? '' : contentPreview(record.content)}
            </span>
            {#if record.tags.length > 0}
              <span class="wiki-record-tags">
                {#each record.tags as tag (tag)}
                  <span class="wiki-record-chip">{tag}</span>
                {/each}
              </span>
            {/if}
            {#if searchResults && record.article_id !== articleId}
              <span class="wiki-record-foreign subtle">(other article)</span>
            {/if}
          </div>
          {#if expandedId === record.id}
            <div class="wiki-record-body">
              <Markdown content={record.content} />
              <div class="row wiki-record-actions">
                <button type="button" onclick={() => startEdit(record)}>Edit</button>
                <button type="button" onclick={() => downloadRecordMarkdown(record)}>
                  Export
                </button>
                <button type="button" class="danger" onclick={() => void deleteRecord(record)}>
                  Delete
                </button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .wiki-records {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border, rgba(128, 128, 128, 0.3));
  }
  .wiki-records-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .wiki-records-header h2 {
    margin: 0;
  }
  .wiki-records-header-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .wiki-records-search {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .wiki-records-search input[type='search'] {
    flex: 1 1 auto;
  }
  .wiki-records-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .wiki-records-filters label {
    display: flex;
    flex-direction: column;
    font-size: 0.85em;
    gap: 0.25rem;
  }
  .wiki-records-compose {
    margin-bottom: 1rem;
    padding: 0.75rem;
    border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
    border-radius: 6px;
  }
  .wiki-records-compose h3 {
    margin-top: 0;
  }
  .wiki-records-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .wiki-record {
    border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
    border-radius: 6px;
  }
  .wiki-record-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
  }
  .wiki-record-row:hover {
    background: var(--hover-bg, rgba(128, 128, 128, 0.08));
  }
  .wiki-record-date {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 0.85em;
    white-space: nowrap;
  }
  .wiki-record-preview {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted, inherit);
  }
  .wiki-record-tags {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .wiki-record-chip {
    font-size: 0.7em;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--chip-bg, rgba(128, 128, 128, 0.18));
    white-space: nowrap;
  }
  .wiki-record-foreign {
    flex: 0 0 auto;
    font-size: 0.75em;
  }
  .wiki-record-body {
    padding: 0 0.75rem 0.75rem;
  }
  .wiki-record-actions {
    margin-top: 0.5rem;
  }
  /* On a narrow viewport the row's single line gets cramped; let the
     preview wrap under the date instead of clipping aggressively. */
  @media (max-width: 30rem) {
    .wiki-record-row {
      flex-wrap: wrap;
    }
    .wiki-record-preview {
      white-space: normal;
      flex-basis: 100%;
    }
  }
</style>
