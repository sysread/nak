<script lang="ts">
  /*
   * Main-panel view for the document Library. Two surfaces, mutually
   * exclusive on `route.document_id`:
   *
   *   - no document selected: the upload form (pick a file, name it, say what
   *     it is for) plus a short explainer.
   *   - a document selected: its detail view - metadata, an editable
   *     description, a download link for the original, the extracted text, and
   *     a delete control.
   *
   * The sidebar `LibraryList` shares the same `documentStore`, so an upload or
   * delete here updates the drawer without a refetch. All decision logic
   * (byte formatting, status labels) lives in `$lib/ui/library-list`; this
   * file is composition + DOM glue only.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import type { Document } from '$lib/supabase';
  import {
    addDocumentRow,
    patchDocumentRow,
    removeDocumentRow,
  } from '$lib/documents-store.svelte';
  import { emitDocumentChange } from '$lib/document-events';
  import {
    ingestDocument,
    MAX_DOCUMENT_FILE_BYTES,
    MAX_DOCUMENT_TITLE_CHARS,
    MAX_DOCUMENT_DESCRIPTION_CHARS,
  } from '$lib/documents';
  import { formatBytes, statusLabel } from '$lib/ui/library-list';

  // Selected-document state, driven by route.document_id.
  let doc = $state<Document | null>(null);
  let loadingDoc = $state(false);
  let loadError = $state<string | null>(null);

  // Inline details editor (title + description).
  let editingDetails = $state(false);
  let titleDraft = $state('');
  let descriptionDraft = $state('');
  let savingDetails = $state(false);
  let detailsError = $state<string | null>(null);

  // Upload form state.
  let fileInput = $state<HTMLInputElement | null>(null);
  let pendingFile = $state<File | null>(null);
  let uploadTitle = $state('');
  let uploadDescription = $state('');
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);

  let deleting = $state(false);

  // Fetch the selected document whenever the route id changes. Clearing the
  // id drops back to the upload surface.
  $effect(() => {
    const id = route.document_id;
    if (!id || !app.supabase) {
      doc = null;
      return;
    }
    loadingDoc = true;
    loadError = null;
    editingDetails = false;
    detailsError = null;
    void app.supabase
      .getDocumentById(id)
      .then((row) => {
        doc = row;
        if (!row) loadError = 'Document not found.';
      })
      .catch((err) => {
        loadError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        loadingDoc = false;
      });
  });

  function onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    uploadError = null;
    if (file && file.size > MAX_DOCUMENT_FILE_BYTES) {
      uploadError = `That file is too large (max ${formatBytes(MAX_DOCUMENT_FILE_BYTES)}).`;
      pendingFile = null;
      return;
    }
    pendingFile = file;
    // Default the title to the filename so the common case is one click.
    if (file && uploadTitle.trim().length === 0) uploadTitle = file.name;
  }

  async function submitUpload(): Promise<void> {
    if (!app.supabase || !pendingFile || uploading) return;
    uploading = true;
    uploadError = null;
    try {
      const id = await ingestDocument(
        {
          title: uploadTitle.trim() || pendingFile.name,
          description: uploadDescription.trim(),
          file: pendingFile,
        },
        { supabase: app.supabase }
      );
      // Pull the freshly-ingested row (now carrying its final extraction
      // status) into the shared store and open it.
      const created = await app.supabase.getDocumentById(id);
      if (created) addDocumentRow(created);
      emitDocumentChange();
      resetUploadForm();
      navigate({ document_id: id });
    } catch (err) {
      uploadError = err instanceof Error ? err.message : String(err);
    } finally {
      uploading = false;
    }
  }

  function resetUploadForm(): void {
    pendingFile = null;
    uploadTitle = '';
    uploadDescription = '';
    if (fileInput) fileInput.value = '';
  }

  function startEditDetails(): void {
    if (!doc) return;
    titleDraft = doc.title;
    descriptionDraft = doc.description;
    detailsError = null;
    editingDetails = true;
  }

  async function saveDetails(): Promise<void> {
    if (!app.supabase || !doc || savingDetails) return;
    const title = titleDraft.trim().slice(0, MAX_DOCUMENT_TITLE_CHARS);
    if (title.length === 0) {
      detailsError = 'Title cannot be empty.';
      return;
    }
    savingDetails = true;
    detailsError = null;
    try {
      const description = descriptionDraft.trim().slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS);
      const updated = await app.supabase.updateDocument(doc.id, { title, description });
      doc = updated;
      patchDocumentRow(updated.id, { title: updated.title, description: updated.description });
      emitDocumentChange();
      editingDetails = false;
    } catch (err) {
      detailsError = err instanceof Error ? err.message : String(err);
    } finally {
      savingDetails = false;
    }
  }

  async function downloadOriginal(): Promise<void> {
    if (!app.supabase || !doc?.storage_path) return;
    try {
      const url = await app.supabase.createDocumentDownloadUrl(doc.storage_path);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  async function deleteDocument(): Promise<void> {
    if (!app.supabase || !doc || deleting) return;
    if (!confirm(`Delete "${doc.title}"? This removes the file and its searchable text permanently.`)) {
      return;
    }
    deleting = true;
    try {
      const id = doc.id;
      await app.supabase.deleteDocument(id);
      removeDocumentRow(id);
      emitDocumentChange();
      navigate({ document_id: null });
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      deleting = false;
    }
  }

  function uploadedOn(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  }
</script>

<div class="library-panel">
  {#if route.document_id}
    {#if loadingDoc}
      <p class="subtle">Loading document...</p>
    {:else if loadError}
      <p class="error">{loadError}</p>
    {:else if doc}
      <header class="library-doc-header">
        {#if !editingDetails}
          <h2>{doc.title}</h2>
        {/if}
        <div class="library-doc-meta subtle">
          <span>{doc.filename}</span>
          <span>{formatBytes(doc.size_bytes)}</span>
          {#if uploadedOn(doc.created_at)}<span>Uploaded {uploadedOn(doc.created_at)}</span>{/if}
          {#if statusLabel(doc.extraction_status)}
            <span class:error={doc.extraction_status === 'failed'}>
              {statusLabel(doc.extraction_status)}
            </span>
          {/if}
        </div>
        {#if !editingDetails}
          <div class="library-doc-actions">
            {#if doc.storage_path}
              <button class="secondary" onclick={() => downloadOriginal()}>Download original</button>
            {/if}
            <button class="secondary" onclick={() => startEditDetails()}>Edit</button>
            <button class="danger" onclick={() => deleteDocument()} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        {/if}
      </header>

      {#if editingDetails}
        <!-- Edit details: title (the rename) + description, saved together. -->
        <section class="library-doc-edit">
          <label class="library-field">
            <span>Title</span>
            <input type="text" bind:value={titleDraft} maxlength={MAX_DOCUMENT_TITLE_CHARS} />
          </label>
          <label class="library-field">
            <span>What this is for</span>
            <textarea
              bind:value={descriptionDraft}
              rows="3"
              maxlength={MAX_DOCUMENT_DESCRIPTION_CHARS}
              placeholder="Describe what this document is, so it's easy to find later."
            ></textarea>
          </label>
          {#if detailsError}<p class="error">{detailsError}</p>{/if}
          <div class="row">
            <button onclick={() => saveDetails()} disabled={savingDetails}>
              {savingDetails ? 'Saving...' : 'Save'}
            </button>
            <button class="secondary" onclick={() => (editingDetails = false)}>Cancel</button>
          </div>
        </section>
      {:else}
        <section class="library-doc-description">
          <h3>What this is for</h3>
          {#if doc.description}
            <p>{doc.description}</p>
          {:else}
            <p class="subtle">No description yet.</p>
          {/if}
        </section>
      {/if}

      {#if doc.extraction_status === 'failed'}
        <p class="error">
          Couldn't extract text from this file, so it isn't searchable
          {doc.extraction_error ? `: ${doc.extraction_error}` : '.'}
          The original is still downloadable. Re-upload to try again.
        </p>
      {:else if doc.extracted_text}
        <section class="library-doc-text">
          <h3>Extracted text</h3>
          <pre>{doc.extracted_text}</pre>
        </section>
      {:else}
        <p class="subtle">Text is still being extracted...</p>
      {/if}
    {/if}
  {:else}
    <!-- Upload surface (no document selected). -->
    <header>
      <h2>Library</h2>
      <p class="subtle">
        Upload documents you want kept as permanent, searchable reference
        material - insurance policies, contracts, tax documents, anything text
        can be pulled from. Unlike chat attachments, these never expire, and
        the assistant can search inside them to answer your questions.
      </p>
    </header>

    <section class="library-upload">
      <input
        bind:this={fileInput}
        type="file"
        onchange={onFilePicked}
        aria-label="Choose a file to upload"
      />
      {#if pendingFile}
        <label class="library-field">
          <span>Title</span>
          <input type="text" bind:value={uploadTitle} placeholder={pendingFile.name} />
        </label>
        <label class="library-field">
          <span>What this is for</span>
          <textarea
            bind:value={uploadDescription}
            rows="3"
            maxlength={MAX_DOCUMENT_DESCRIPTION_CHARS}
            placeholder="e.g. 2024 Aetna health insurance policy"
          ></textarea>
        </label>
        <div class="row">
          <button onclick={() => submitUpload()} disabled={uploading}>
            {uploading ? 'Uploading...' : 'Save to Library'}
          </button>
          <button class="secondary" onclick={() => resetUploadForm()} disabled={uploading}>
            Cancel
          </button>
        </div>
      {/if}
      {#if uploadError}<p class="error">{uploadError}</p>{/if}
      {#if !app.venice}
        <p class="subtle">Set up Venice in Settings to extract text from uploads.</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .library-panel {
    max-width: 52rem;
    margin: 0 auto;
    padding: 1rem 1.25rem 3rem;
    width: 100%;
  }
  .library-doc-header h2 {
    margin: 0 0 0.35rem;
  }
  .library-doc-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.82rem;
  }
  .library-doc-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .library-doc-edit {
    margin-top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: flex-start;
  }
  .library-doc-description,
  .library-doc-text {
    margin-top: 1.5rem;
  }
  .library-doc-text pre {
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 28rem;
    overflow: auto;
    padding: 0.75rem;
    border: 1px solid var(--border, #444);
    border-radius: 0.4rem;
    font-size: 0.85rem;
  }
  .library-upload {
    margin-top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: flex-start;
  }
  .library-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
  }
  .library-field span {
    font-size: 0.82rem;
    opacity: 0.75;
  }
  .library-field input,
  .library-field textarea {
    width: 100%;
  }
</style>
