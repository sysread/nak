<!--
  Right-side drawer that renders the text Venice's text-parser
  extracted from a document attachment. Opened from the "Extracted
  text" button on any attachment row (live or expired) in the message
  transcript. Wired via the singleton rune store in
  `extractedTextDrawer.svelte.ts` — this component reads the payload
  and renders when set.

  The drawer slides in from the right on top of the transcript, same
  pattern as the mobile sidebar drawer but horizontally mirrored. A
  full-height overlay behind it dismisses on click, and Escape closes
  it too — matches the conventions users have in every other modal
  surface in the app.

  Why a `<pre>` for the body: extracted text from PDFs and source
  files usually carries its own whitespace (line breaks, indentation)
  that a reflowing `<div>` would collapse into illegible flow. `<pre>`
  preserves the parser's output verbatim; the wrap rule ensures long
  lines still fit the drawer width without horizontal scrolling.
-->
<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { extractedTextDrawer } from '$lib/extractedTextDrawer.svelte';

  const drawer = extractedTextDrawer;

  function onOverlayKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') drawer.close();
  }

  // Escape anywhere — including when focus is inside the drawer —
  // closes the drawer. Scoped to document because the drawer itself
  // doesn't own a focusable element; users may still be focused on
  // the composer when they hit Escape expecting to dismiss.
  $effect(() => {
    if (!drawer.state.payload) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') drawer.close();
    };
    document.addEventListener('keydown', handler);
    return (): void => document.removeEventListener('keydown', handler);
  });
</script>

{#if drawer.state.payload}
  {@const payload = drawer.state.payload}
  <!--
    Click-outside dismissal. A button role + keyboard handler keeps
    it accessible — Enter/Space on the overlay closes too.
  -->
  <button
    type="button"
    class="extracted-text-overlay"
    aria-label="Close extracted text"
    onclick={() => drawer.close()}
    onkeydown={onOverlayKey}
    transition:fade={{ duration: 150, easing: cubicOut }}
  ></button>
  <!--
    `<aside>` is semantically the right container for a supplemental
    side panel; `role="dialog"` would override that to an interactive
    role the element can't fulfil. We keep the default aside role and
    rely on aria-label for the screen-reader announcement.
  -->
  <aside
    class="extracted-text-drawer"
    aria-label="Extracted text from {payload.filename}"
    transition:fly={{ x: 360, duration: 220, easing: cubicOut }}
  >
    <header class="extracted-text-header">
      <h2 class="extracted-text-title">{payload.filename}</h2>
      <button
        type="button"
        class="secondary icon-btn"
        aria-label="Close"
        onclick={() => drawer.close()}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            fill="none"
          />
        </svg>
      </button>
    </header>
    {#if payload.text.trim().length === 0}
      <p class="extracted-text-empty">No text extracted from this file.</p>
    {:else}
      <pre class="extracted-text-body">{payload.text}</pre>
    {/if}
  </aside>
{/if}

<style>
  .extracted-text-overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--bg) 55%, transparent);
    /* Sit above the transcript but below the drawer itself so a click
       on the drawer doesn't dismiss it. */
    z-index: 40;
    border: 0;
    padding: 0;
    cursor: pointer;
  }

  /* Shell bg matches the threads sidebar (--bg-2) so the drawer reads
     as a peer panel rather than floating chrome. The body below
     drops back to --bg for contrast against the header. */
  .extracted-text-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(480px, 92vw);
    display: flex;
    flex-direction: column;
    background: var(--bg-2);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 24px color-mix(in srgb, #000 18%, transparent);
    z-index: 41;
  }

  .extracted-text-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }

  .extracted-text-title {
    flex: 1 1 auto;
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    word-break: break-all;
  }

  .extracted-text-body {
    flex: 1 1 auto;
    margin: 0;
    padding: 0.9rem;
    overflow: auto;
    /* Preserve the parser's newlines AND wrap long lines so a wide
       PDF column still fits the drawer. */
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
    font-size: 0.85rem;
    line-height: 1.45;
    color: var(--text);
    background: var(--bg);
  }

  .extracted-text-empty {
    margin: 0;
    padding: 0.9rem;
    color: var(--muted);
    font-style: italic;
  }
</style>
