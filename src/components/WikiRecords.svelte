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
  import {
    searchWikiRecordsSemantic,
    MAX_WIKI_RECORD_CONTENT_CHARS,
    MAX_RECORD_LINK_LABEL_CHARS,
  } from '$lib/wiki';
  import type { WikiArticle, WikiRecord, WikiRecordFile, WikiRecordLinkView } from '$lib/supabase';
  import { downloadRecordMarkdown, downloadArticleZip } from '$lib/wiki-export';
  import { emitWikiRecordChange, onWikiRecordChange } from '$lib/wiki-events';
  import {
    validateFile,
    isImageMimeType,
    maybeDownscaleImage,
    arrayBufferToBase64,
  } from '$lib/attachments';
  import {
    formatRecordDate,
    contentPreview,
    parseTags,
    serializeTags,
    recordsHeadline,
    recordFileBadgeLabel,
    recordsEmptyMessage,
    collectTags,
    todayIso,
    partitionRecordFiles,
    formatRecordFileMeta,
    describeLink,
    linkCandidates,
    validateLinkLabel,
    validateRecordForm,
  } from '$lib/ui/wiki-records';
  import Markdown from './Markdown.svelte';
  import { WIKI_RECORDS_ANCHOR } from '$lib/ui/wiki-toc-sections';

  interface Props {
    article: WikiArticle;
    /**
     * Fired after each load with this article's record count, so the
     * parent (Wiki.svelte) can decide whether to show a "Records" link
     * in the article ToC. Fires with 0 when the article has no records.
     */
    onCount?: (count: number) => void;
  }
  const { article, onCount }: Props = $props();
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

  // --- files + links for the expanded record ---------------------------
  // Loaded lazily for whichever record is open (only one at a time), so
  // the list view stays a cheap single query; the heavier file/link
  // fetches happen only on expand. Keyed implicitly by expandedId via the
  // load effect below.
  let expandedFiles = $state<WikiRecordFile[]>([]);
  let expandedFileUrls = $state<Map<string, string>>(new Map());
  let expandedLinks = $state<WikiRecordLinkView[]>([]);
  let extrasError = $state<string | null>(null);
  let uploadBusy = $state(false);
  let dragOver = $state(false);

  // Link compose state.
  let linkTargetId = $state('');
  let linkLabel = $state('');
  let linkBusy = $state(false);
  let linkError = $state<string | null>(null);

  const partitionedFiles = $derived(partitionRecordFiles(expandedFiles, expandedFileUrls));
  const linkOptions = $derived(
    expandedId ? linkCandidates(records, expandedId, expandedLinks) : []
  );

  async function loadExtras(recordId: string): Promise<void> {
    if (!app.supabase) return;
    extrasError = null;
    try {
      const [files, links] = await Promise.all([
        app.supabase.listWikiRecordFiles(recordId),
        app.supabase.listWikiRecordLinks(recordId),
      ]);
      expandedFiles = files;
      expandedLinks = links;
      expandedFileUrls = await app.supabase.createWikiRecordFileSignedUrls(files);
    } catch (err) {
      extrasError = err instanceof Error ? err.message : 'Failed to load files and links.';
    }
  }

  // (Re)load the open record's files + links on expand and on any record
  // write (the bus also fires for file/link mutations via the realtime
  // relay). Collapsing clears the extras so a stale set never flashes when
  // a different record is opened next.
  $effect(() => {
    const id = expandedId;
    if (!id) {
      expandedFiles = [];
      expandedLinks = [];
      expandedFileUrls = new Map();
      return;
    }
    void loadExtras(id);
    const off = onWikiRecordChange(() => void loadExtras(id));
    return () => off();
  });

  async function attachFiles(record: WikiRecord, files: FileList | File[]): Promise<void> {
    if (!app.supabase || files.length === 0) return;
    uploadBusy = true;
    extrasError = null;
    try {
      let position = expandedFiles.length;
      for (const original of Array.from(files)) {
        const sizeError = validateFile(original);
        if (sizeError) {
          extrasError = sizeError;
          continue;
        }
        // Images get the same canvas downscale the chat composer applies
        // before upload; a null return means "leave the original alone".
        const isImage = isImageMimeType(original.type);
        const file = isImage ? ((await maybeDownscaleImage(original)) ?? original) : original;
        const base64 = arrayBufferToBase64(await file.arrayBuffer());
        // Extract text for non-image docs so the chat model can read the
        // attachment via record_get. Best-effort: a parser failure still
        // attaches the file, just without searchable text.
        let extractedText: string | null = null;
        if (!isImage) {
          try {
            extractedText = await app.supabase.extractText(file, file.name);
          } catch {
            extractedText = null;
          }
        }
        await app.supabase.uploadAndAttachWikiRecordFile({
          recordId: record.id,
          articleId: record.article_id,
          recordDate: record.date,
          position: position++,
          filename: file.name,
          mimeType: file.type || original.type || null,
          sizeBytes: file.size,
          dataBase64: base64,
          extractedText,
        });
      }
      emitWikiRecordChange();
    } catch (err) {
      extrasError = err instanceof Error ? err.message : 'Failed to attach file.';
    } finally {
      uploadBusy = false;
    }
  }

  function onFileInput(record: WikiRecord, e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) void attachFiles(record, input.files);
    input.value = '';
  }

  function onDrop(record: WikiRecord, e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void attachFiles(record, files);
  }

  async function removeFile(fileId: string): Promise<void> {
    if (!app.supabase) return;
    if (!confirm('Remove this file? This cannot be undone.')) return;
    try {
      await app.supabase.deleteWikiRecordFile(fileId);
      emitWikiRecordChange();
    } catch (err) {
      extrasError = err instanceof Error ? err.message : 'Failed to remove file.';
    }
  }

  async function addLink(record: WikiRecord): Promise<void> {
    if (!app.supabase || !linkTargetId) return;
    const labelErr = validateLinkLabel(linkLabel);
    if (labelErr) {
      linkError = labelErr;
      return;
    }
    linkBusy = true;
    linkError = null;
    try {
      await app.supabase.createWikiRecordLink({
        fromRecordId: record.id,
        toRecordId: linkTargetId,
        label: linkLabel.trim() || null,
      });
      linkTargetId = '';
      linkLabel = '';
      emitWikiRecordChange();
    } catch (err) {
      linkError = err instanceof Error ? err.message : 'Failed to link records.';
    } finally {
      linkBusy = false;
    }
  }

  async function removeLink(record: WikiRecord, view: WikiRecordLinkView): Promise<void> {
    if (!app.supabase) return;
    // The stored edge runs from the link's "from" record to its "to"
    // record; reconstruct the original direction so the delete matches the
    // unique pair regardless of which end we're viewing from.
    const fromId = view.direction === 'outgoing' ? record.id : view.record.id;
    const toId = view.direction === 'outgoing' ? view.record.id : record.id;
    try {
      await app.supabase.deleteWikiRecordLink({ fromRecordId: fromId, toRecordId: toId });
      emitWikiRecordChange();
    } catch (err) {
      extrasError = err instanceof Error ? err.message : 'Failed to remove link.';
    }
  }

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
    const filtersActive = !!(fromDate || toDate || tagFilter);
    try {
      records = await app.supabase.listWikiRecords(articleId, {
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        tags: tagFilter ? [tagFilter] : undefined,
      });
      // Report the article's true record count for the ToC link only on
      // an unfiltered load - a filtered list of 0 doesn't mean the
      // article has no records, so leave the last reported count standing.
      if (!filtersActive) onCount?.(records.length);
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

<section class="wiki-records" id={WIKI_RECORDS_ANCHOR} aria-label="Records">
  <header class="wiki-records-header">
    <h2>{recordsHeadline(searchResults ? searchResults.length : records.length)}</h2>
    <div class="wiki-records-header-actions">
      {#if records.length > 0}
        <!-- Exports this article's records (filters/search aside) plus the
             article body as a ZIP. Uses the unfiltered `records` rather
             than `visible` so a download is always the full set. -->
        <button
          type="button"
          class="icon-btn"
          onclick={() => downloadArticleZip(article, records)}
          title="Export all records"
          aria-label="Export all records"
        >
          <!-- Feather "download" - matches the 16x16 stroke icons in the
               app footer / top bar. -->
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
          title="Add record"
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
    <button
      type="button"
      class="icon-btn"
      onclick={() => void runSearch()}
      disabled={searching}
      title="Search records"
      aria-label={searching ? 'Searching records' : 'Search records'}
    >
      <!-- Feather "search" (magnifying glass) - matches the +/download
           icon buttons in the Records header. -->
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
            <!-- Attachment badge: collapsed rows don't load the file strip,
                 so a count from the list query stands in. Hidden when the
                 record has no files or while it's expanded (the strip itself
                 is then visible). -->
            {#if expandedId !== record.id && recordFileBadgeLabel(record.fileCount)}
              <span
                class="wiki-record-files-badge"
                title={recordFileBadgeLabel(record.fileCount)}
                aria-label={recordFileBadgeLabel(record.fileCount)}
              >
                <!-- Feather "paperclip" - generic attachment glyph (a record
                     may hold images and/or documents). -->
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path
                    d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                  />
                </svg>
                {record.fileCount}
              </span>
            {/if}
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

              {#if extrasError}
                <p class="error">{extrasError}</p>
              {/if}

              <!-- Files: image thumbnails + document download chips, plus a
                   drag/drop + picker upload zone. Bytes land in the
                   persistent wiki-record-files bucket. -->
              <div class="wiki-record-files">
                {#if partitionedFiles.images.length > 0}
                  <div class="wiki-record-thumbs">
                    {#each partitionedFiles.images as view (view.file.id)}
                      <div class="wiki-record-thumb">
                        {#if view.url}
                          <a href={view.url} target="_blank" rel="noopener noreferrer">
                            <img src={view.url} alt={view.file.filename} loading="lazy" />
                          </a>
                        {:else}
                          <div class="wiki-record-thumb-placeholder" aria-hidden="true"></div>
                        {/if}
                        <button
                          type="button"
                          class="wiki-record-file-remove"
                          title="Remove file"
                          aria-label={`Remove ${view.file.filename}`}
                          onclick={() => void removeFile(view.file.id)}
                        >×</button>
                      </div>
                    {/each}
                  </div>
                {/if}
                {#if partitionedFiles.docs.length > 0}
                  <ul class="wiki-record-docs">
                    {#each partitionedFiles.docs as view (view.file.id)}
                      <li class="wiki-record-doc">
                        {#if view.url}
                          <a href={view.url} target="_blank" rel="noopener noreferrer">
                            {formatRecordFileMeta(view.file)}
                          </a>
                        {:else}
                          <span>{formatRecordFileMeta(view.file)}</span>
                        {/if}
                        <button
                          type="button"
                          class="wiki-record-file-remove"
                          title="Remove file"
                          aria-label={`Remove ${view.file.filename}`}
                          onclick={() => void removeFile(view.file.id)}
                        >×</button>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="wiki-record-dropzone"
                  class:drag-over={dragOver}
                  ondragover={(e) => {
                    e.preventDefault();
                    dragOver = true;
                  }}
                  ondragleave={() => (dragOver = false)}
                  ondrop={(e) => onDrop(record, e)}
                >
                  <label class="wiki-record-upload-label">
                    {uploadBusy ? 'Uploading…' : 'Attach a file or drop here'}
                    <input
                      type="file"
                      multiple
                      disabled={uploadBusy}
                      onchange={(e) => onFileInput(record, e)}
                    />
                  </label>
                </div>
              </div>

              <!-- Cross-links: this record's relationships to others
                   ("attempt #3 based on attempt #2"). -->
              <div class="wiki-record-links">
                {#if expandedLinks.length > 0}
                  <ul class="wiki-record-link-list">
                    {#each expandedLinks as view (view.id)}
                      {@const d = describeLink(view)}
                      <li class="wiki-record-link">
                        <span class="wiki-record-link-arrow" aria-hidden="true">{d.arrow}</span>
                        <span class="wiki-record-link-label">{d.label}</span>
                        <span class="wiki-record-link-preview subtle">{d.preview}</span>
                        <button
                          type="button"
                          class="wiki-record-file-remove"
                          title="Remove link"
                          aria-label="Remove link"
                          onclick={() => void removeLink(record, view)}
                        >×</button>
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if linkOptions.length > 0}
                  <div class="wiki-record-link-form form-row">
                    <select bind:value={linkTargetId} disabled={linkBusy} aria-label="Record to link">
                      <option value="">Link to a record…</option>
                      {#each linkOptions as candidate (candidate.id)}
                        <option value={candidate.id}>
                          {formatRecordDate(candidate.date)} - {contentPreview(candidate.content, 40)}
                        </option>
                      {/each}
                    </select>
                    <input
                      type="text"
                      bind:value={linkLabel}
                      disabled={linkBusy}
                      maxlength={MAX_RECORD_LINK_LABEL_CHARS}
                      placeholder="label (e.g. based on)"
                      autocomplete="off"
                    />
                    <button
                      type="button"
                      onclick={() => void addLink(record)}
                      disabled={linkBusy || !linkTargetId}
                    >Link</button>
                  </div>
                  {#if linkError}
                    <p class="error">{linkError}</p>
                  {/if}
                {/if}
              </div>

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
  .wiki-record-files-badge {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.72em;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted, inherit);
    /* baseline-aligned row, but the glyph reads better nudged down a hair */
  }
  .wiki-record-files-badge svg {
    flex: 0 0 auto;
    transform: translateY(1px);
    opacity: 0.85;
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
  .wiki-record-files {
    margin-top: 0.75rem;
  }
  .wiki-record-thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .wiki-record-thumb {
    position: relative;
    width: 96px;
    height: 96px;
  }
  .wiki-record-thumb img {
    width: 96px;
    height: 96px;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
    display: block;
  }
  .wiki-record-thumb-placeholder {
    width: 96px;
    height: 96px;
    border-radius: 6px;
    border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
    background: var(--chip-bg, rgba(128, 128, 128, 0.18));
  }
  .wiki-record-docs {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .wiki-record-doc {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  /* Small circular "remove" affordance shared by file thumbs, doc rows,
     and link rows. Absolutely positioned on a thumb, inline elsewhere. */
  .wiki-record-file-remove {
    border: none;
    background: var(--chip-bg, rgba(128, 128, 128, 0.25));
    color: inherit;
    border-radius: 999px;
    width: 1.25rem;
    height: 1.25rem;
    line-height: 1;
    cursor: pointer;
    flex: 0 0 auto;
    padding: 0;
  }
  .wiki-record-file-remove:hover {
    background: var(--danger-bg, rgba(220, 80, 80, 0.25));
  }
  .wiki-record-thumb .wiki-record-file-remove {
    position: absolute;
    top: -0.4rem;
    right: -0.4rem;
  }
  .wiki-record-dropzone {
    border: 1px dashed var(--border, rgba(128, 128, 128, 0.4));
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    text-align: center;
    font-size: 0.85em;
  }
  .wiki-record-dropzone.drag-over {
    background: var(--hover-bg, rgba(128, 128, 128, 0.12));
    border-color: var(--accent, rgba(128, 128, 255, 0.6));
  }
  .wiki-record-upload-label {
    cursor: pointer;
    display: inline-block;
  }
  .wiki-record-upload-label input[type='file'] {
    display: none;
  }
  .wiki-record-links {
    margin-top: 0.75rem;
  }
  .wiki-record-link-list {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .wiki-record-link {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .wiki-record-link-arrow {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    flex: 0 0 auto;
  }
  .wiki-record-link-label {
    font-weight: 600;
    flex: 0 0 auto;
  }
  .wiki-record-link-preview {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wiki-record-link-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .wiki-record-link-form select {
    flex: 1 1 12rem;
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
