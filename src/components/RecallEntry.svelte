<script lang="ts">
  /**
   * One turn-entry in the Recall diagnostics modal: the triggering user
   * prompt paired with the first-person recollection that was injected
   * before the assistant replied, plus a slide-down of the cited sources
   * behind it.
   *
   * Owns the per-entry citations state (open + flash) and the click
   * delegation that:
   *   (a) opens + flashes the sources panel when a `^N^` superscript in
   *       the note is clicked - the same mechanism AssistantBody uses for
   *       web-search citations; and
   *   (b) navigates to a cited source (memory / conversation / wiki) when
   *       a panel row's `?key=id` link is clicked, closing this modal via
   *       the nav patch's `modal: null`.
   *
   * Decision logic (citation -> display row, href -> nav patch, count ->
   * label) lives in src/lib/ui/citations.ts; this file is the glue.
   */
  import Markdown from './Markdown.svelte';
  import CitationsPanel from './CitationsPanel.svelte';
  import { navigate } from '$lib/routing.svelte';
  import type { ContextRecallPayload } from '$lib/context-recall';
  import type { Message } from '$lib/supabase';
  import { formatRecallTimestamp, formatRecallTrigger } from '$lib/ui/recall';
  import { formatRelativeAge } from '$lib/ui/payload-freshness';
  import {
    citationFlashDelay,
    hasCitationRefsInBody,
    isCitationsUnavailable,
    parseCitationRefHref,
    showCitationsControls,
  } from '$lib/ui/assistant-body';
  import {
    parseRecallCitationNav,
    recallCitationToDisplay,
    sourcesLabel,
  } from '$lib/ui/citations';

  interface Props {
    entry: ContextRecallPayload;
    /** The user message that triggered this injection, if still loaded
     *  in the transcript (absent when edited / deleted since). */
    userMsg: Message | undefined;
    /** Whether to show the "stale" badge - true only for the live cache
     *  entry when it's old enough to be suppressed at injection time. */
    stale: boolean;
    /** Snapshot "now" (ms) for the relative-age line. */
    now: number;
  }
  let { entry, userMsg, stale, now }: Props = $props();

  const displayCitations = $derived(
    entry.citations.map(recallCitationToDisplay)
  );
  const hasCitations = $derived(displayCitations.length > 0);
  const hasRefs = $derived(hasCitationRefsInBody(entry.note));
  const citationsUnavailable = $derived(
    isCitationsUnavailable(hasRefs, hasCitations)
  );
  const controlsVisible = $derived(
    showCitationsControls(hasCitations, citationsUnavailable)
  );

  let citationsOpen = $state(false);
  /** One-shot flash token bumped per superscript click; see CitationsPanel. */
  let flashCite = $state<{ index: number; key: number } | null>(null);
  let flashCounter = 0;

  function onEntryClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;

    // A `^N^` superscript in the note: open the panel and flash row N,
    // mirroring AssistantBody. The orphan-refs case (refs but no stored
    // citations) opens to the "sources not saved" notice with no row to
    // flash, so we skip the flash scheduling there.
    const ref = target.closest('a.citation-ref');
    if (ref instanceof HTMLAnchorElement) {
      e.preventDefault();
      const idx = parseCitationRefHref(ref.getAttribute('href') ?? '');
      if (idx === null) return;
      const wasOpen = citationsOpen;
      if (!citationsOpen) citationsOpen = true;
      if (citationsUnavailable) return;
      window.setTimeout(() => {
        flashCounter += 1;
        flashCite = { index: idx, key: flashCounter };
      }, citationFlashDelay(wasOpen));
      return;
    }

    // A citation row's `?key=id` link: navigate to the source. The patch
    // clears `modal`, which closes this Recall modal as it navigates.
    const link = target.closest('a[href^="?"]');
    if (link instanceof HTMLAnchorElement) {
      const patch = parseRecallCitationNav(link.getAttribute('href') ?? '');
      if (!patch) return;
      e.preventDefault();
      navigate(patch);
    }
  }
</script>

<!-- The section is a click-delegation host for the native anchors the
     Markdown render and the CitationsPanel emit; it isn't an interactive
     surface in its own right. Same a11y concession as AssistantBody. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<section class="entry" onclick={onEntryClick}>
  <h2 class="turn-heading">Turn {entry.computed_at_round}</h2>

  <h3 class="sub-heading">User</h3>
  {#if userMsg && userMsg.content.trim().length > 0}
    <p class="user-prompt">{userMsg.content}</p>
  {:else}
    <!-- A round number with no matching user message in the loaded
         transcript - the row may have been edited or deleted since the
         injection fired. Keep the diagnostic visible; the injection
         still tells the user what Nak was thinking about. -->
    <p class="user-prompt subtle missing">(user message no longer available)</p>
  {/if}

  <h3 class="sub-heading">Internal context</h3>
  <!-- A div, not a p: Markdown emits block content (paragraphs, lists)
       which is invalid nested inside a <p>. The floated bulb is a sibling
       preceding the .md block, and .recall-prose is a flow-root, so the
       note's first line wraps around the drop cap. -->
  <div class="recall-prose">
    <!-- Drop-capped light bulb at the start of the first line - the
         chapter-opener metaphor. SVG (not emoji) for crisp rendering at
         the large drop-cap size across platforms. -->
    <svg
      class="recall-bulb"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.7.7 1 1.7 1 2.7V18h6v-.6c0-1 .3-2 1-2.7A7 7 0 0 0 12 2z" />
    </svg>
    <Markdown content={entry.note} />
  </div>

  {#if controlsVisible}
    <!-- Sources toggle: opens the same panel a `^N^` superscript click
         would. Orphan-refs case renders a dashed "Sources" with no count
         so the user knows it surfaces a status note, not a live list. -->
    <button
      type="button"
      class="sources-toggle"
      class:active={citationsOpen}
      class:unavailable={citationsUnavailable}
      onclick={() => {
        citationsOpen = !citationsOpen;
      }}
      aria-pressed={citationsOpen}
    >
      {citationsUnavailable ? 'Sources' : sourcesLabel(displayCitations.length)}
    </button>
  {/if}

  <CitationsPanel
    citations={displayCitations}
    open={citationsOpen}
    unavailable={citationsUnavailable}
    {flashCite}
  />

  <p class="entry-meta subtle">
    {formatRecallTrigger(entry.trigger)} · {formatRecallTimestamp(entry.computed_at_at)}
    ({formatRelativeAge(entry.computed_at_at, now)})
    {#if stale}
      <span class="stale-badge">stale</span>
    {/if}
  </p>
</section>

<style>
  .entry {
    /* Each turn-entry stands on its own; the hr rule between entries
       (rendered by the parent loop) carries the visual separation. */
    margin: 0;
  }

  .turn-heading {
    font-size: 1rem;
    margin: 0 0 0.5rem;
    color: var(--text);
  }

  .sub-heading {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: color-mix(in srgb, var(--text) 70%, transparent);
    margin: 0.85rem 0 0.3rem;
    font-weight: 600;
  }

  .user-prompt {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border-left: 2px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    background: color-mix(in srgb, var(--bg-2) 70%, transparent);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    /* pre-wrap so the user's paragraphing survives verbatim. */
    white-space: pre-wrap;
    line-height: 1.45;
    color: var(--text);
    font-size: 0.9rem;
    /* Keep an enormous prompt from dominating the modal; it stays
       scrollable within the block. */
    max-height: 12rem;
    overflow-y: auto;
  }

  .user-prompt.missing {
    border-left-style: dashed;
    font-style: italic;
  }

  /* Italic prose with a floated-left light bulb acting as a drop cap.
     The container (padding + tinted background + accent left border)
     mirrors the .user-prompt block above so the two halves of an entry
     read as parallel artifacts: your input, the assistant's prior
     thought. flow-root establishes a block formatting context (so the
     floated bulb can't hang out the bottom of a short note) without
     overflow:hidden's clipping. */
  .recall-prose {
    margin: 0;
    padding: 0.65rem 0.85rem;
    border-left: 2px solid color-mix(in srgb, var(--accent) 55%, var(--border));
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    font-style: italic;
    line-height: 1.7;
    color: var(--text);
    display: flow-root;
  }

  .recall-bulb {
    float: left;
    width: 2.4rem;
    height: 2.4rem;
    margin: 0.1rem 0.6rem 0 0;
    color: color-mix(in srgb, var(--accent) 75%, var(--text));
    /* Soft glow so the bulb reads as illuminated; tints with the user's
       accent setting via the same blend. */
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 35%, transparent));
  }

  /* Sources toggle: small, unobtrusive, sits between the note and the
     panel. Accent-tinted when active; dashed + muted in the orphan-refs
     state to signal "status note, not a live list". */
  .sources-toggle {
    margin-top: 0.5rem;
    padding: 0.2rem 0.6rem;
    font-size: 0.78rem;
    color: var(--accent);
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .sources-toggle:hover {
    background: var(--bg-2);
  }

  .sources-toggle.active {
    background: var(--accent-weak);
  }

  .sources-toggle.unavailable {
    color: color-mix(in srgb, var(--text) 65%, transparent);
    border-style: dashed;
  }

  .entry-meta {
    margin: 0.6rem 0 0;
    font-size: 0.78rem;
  }

  /* "stale" chip on the live cache entry: old enough that the chat-loop
     would suppress it at injection time. Warm hue = soft warning. */
  .stale-badge {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0 0.35rem;
    border-radius: var(--radius-md);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--bg);
    background: var(--warning, #b8860b);
  }

  .subtle {
    color: color-mix(in srgb, var(--text) 65%, transparent);
  }
</style>
