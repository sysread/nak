<!--
  Per-message attachment list rendered under the body of a user message
  (uploads) or an assistant message (generate_image output). Two groups,
  split by `partitionAttachments`:

    - Live images render as large inline previews, about 85% of the
      message-card width, wrapped in a download anchor. Same treatment
      for user-uploaded and AI-generated images.
    - Everything else (non-image files, plus expired images whose
      binary was reclaimed) renders as a compact chip row:

    - Live attachment: a download anchor (`download=<filename>`) that
      resolves the base64 `data` back into a Blob URL on demand.
    - Expired attachment: the filename only, plus a greyed clock-icon
      and a tooltip explaining that the binary has been reclaimed.
    - Either state: an "Extracted text" button is present when the
      row has a non-empty extracted_text, opening the right-side
      drawer via `extractedTextDrawer.open({...})`.

  Object URLs are created lazily (on first download click) rather than
  eagerly at mount time — users scroll past messages far more often
  than they click download, so upfront Blob construction would waste
  memory on long transcripts. When created, the URL is kept around
  until the component unmounts; `URL.revokeObjectURL` runs in the
  teardown effect so we don't leak a URL per clicked attachment.

  An expired attachment deliberately renders the filename with no
  anchor tag, not even a disabled-styled one, because screen-reader
  users would otherwise hear "link, filename" on a file they can't
  download. The clock icon gets an aria-label so the expired state is
  still announced.
-->
<script lang="ts">
  import type { Attachment } from '$lib/supabase';
  import {
    base64ToBlob,
    dataUrlFor,
    formatBytes,
    isImageMimeType,
  } from '$lib/attachments';
  import { partitionAttachments } from '$lib/ui/message-attachments';
  import { extractedTextDrawer } from '$lib/extractedTextDrawer.svelte';

  interface Props {
    attachments: Attachment[];
  }

  const { attachments }: Props = $props();

  // Live images render large; files (and expired images) render as
  // chips. Decision logic lives in the UI primitive, not the markup.
  const partitioned = $derived(partitionAttachments(attachments));

  // Cache of Blob URLs we've created for this component's attachments,
  // keyed by attachment id. Populated lazily and torn down together.
  const blobUrls = new Map<string, string>();

  $effect(() => {
    return (): void => {
      for (const url of blobUrls.values()) URL.revokeObjectURL(url);
      blobUrls.clear();
    };
  });

  function hrefFor(a: Attachment): string | null {
    if (!a.data_base64) return null;
    const cached = blobUrls.get(a.id);
    if (cached) return cached;
    const blob = base64ToBlob(a.data_base64, a.mime_type);
    const url = URL.createObjectURL(blob);
    blobUrls.set(a.id, url);
    return url;
  }

  function openExtractedText(a: Attachment): void {
    if (!a.extracted_text) return;
    extractedTextDrawer.open({ filename: a.filename, text: a.extracted_text });
  }

  // Inline thumbnail source for live image attachments. Cheap to
  // compute — it's just a data: URI wrapping the base64 we already
  // have — and avoids a Blob URL just for the preview.
  function thumbSrc(a: Attachment): string | null {
    if (!isImageMimeType(a.mime_type) || !a.data_base64) return null;
    return dataUrlFor(a.mime_type, a.data_base64);
  }
</script>

{#if partitioned.images.length > 0}
  <div class="msg-attachment-images">
    {#each partitioned.images as a (a.id)}
      <!-- Wrapped in the download anchor so a click saves the original
           file, same affordance the file chips offer. Lightbox/zoom is
           a deliberate follow-up, not wired here. -->
      <a
        href={hrefFor(a)}
        download={a.filename}
        rel="noopener"
        class="msg-attachment-image-link"
        title={`Download ${a.filename}`}
      >
        <img class="msg-attachment-image" src={thumbSrc(a)} alt={a.filename} />
      </a>
    {/each}
  </div>
{/if}

{#if partitioned.files.length > 0}
  <ul class="msg-attachments" role="list">
    {#each partitioned.files as a (a.id)}
      <li class="msg-attachment" class:expired={!!a.expired_at}>
        <svg
          class="msg-attachment-icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <path
            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 0v6h6"
            stroke="currentColor"
            stroke-width="1.6"
            fill="none"
            stroke-linejoin="round"
          />
        </svg>
        <span class="msg-attachment-name">
          {#if a.data_base64}
            <a
              href={hrefFor(a)}
              download={a.filename}
              rel="noopener"
              class="msg-attachment-link"
            >
              {a.filename}
            </a>
          {:else}
            <!-- Expired: no anchor. The filename is still legible so
                 the conversation reads sensibly; the clock icon
                 announces the "reclaimed" state to screen readers. -->
            <span class="msg-attachment-expired-name">{a.filename}</span>
            <span
              class="msg-attachment-expired-badge"
              title="This attachment's binary was reclaimed — only the extracted text remains."
              aria-label="Attachment expired"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6" />
                <path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" />
              </svg>
            </span>
          {/if}
        </span>
        <span class="msg-attachment-size">{formatBytes(a.size_bytes)}</span>
        {#if a.extracted_text && a.extracted_text.trim().length > 0}
          <button
            type="button"
            class="msg-attachment-text-btn"
            onclick={() => openExtractedText(a)}
            title="Open extracted text"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M4 5h12M4 9h12M4 13h8M4 17h10"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                fill="none"
              />
            </svg>
            <span>Text</span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .msg-attachment-images {
    margin: 0.5rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* ~85% of the message-card content width, capped at 100% so the
     preview never spills past the card padding on a narrow viewport.
     The link is the width-constrained block; the img fills it and keeps
     its natural aspect ratio via height:auto. */
  .msg-attachment-image-link {
    display: block;
    width: 85%;
    max-width: 100%;
  }

  .msg-attachment-image {
    display: block;
    width: 100%;
    height: auto;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-0);
  }

  .msg-attachments {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .msg-attachment {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.3rem 0.5rem;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 0.85rem;
    min-width: 0;
  }

  .msg-attachment.expired {
    /* Muted to signal "this file's gone" without being so low-contrast
       that the filename becomes unreadable — a user re-reading a year-
       old conversation still needs to see what was attached. */
    color: var(--muted);
    background: transparent;
    border-style: dashed;
  }

  .msg-attachment-icon {
    color: var(--muted);
    flex: 0 0 auto;
  }

  .msg-attachment-name {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .msg-attachment-link {
    color: var(--accent);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .msg-attachment-link:hover,
  .msg-attachment-link:focus-visible {
    text-decoration: underline;
  }

  .msg-attachment-expired-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .msg-attachment-expired-badge {
    display: inline-flex;
    color: var(--muted);
  }

  .msg-attachment-size {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 0.78rem;
    flex: 0 0 auto;
  }

  .msg-attachment-text-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.15rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) / 2);
    background: transparent;
    color: var(--text);
    font-size: 0.78rem;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .msg-attachment-text-btn:hover,
  .msg-attachment-text-btn:focus-visible {
    background: var(--bg-1);
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
