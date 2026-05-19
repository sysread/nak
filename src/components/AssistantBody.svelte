<!--
  Assistant message body — everything inside an `.msg.assistant` bubble
  EXCEPT the in-progress streaming branch (which is rendered directly
  in Chat.svelte because it wires up live state). Used in two places:
  the plain-text assistant block and the tool-group block; in the tool
  case the `children` snippet slots the `<ToolCalls>` card between the
  markdown and the action bar.

  What this component owns:

    - Markdown render of `content`, including delegated clicks on the
      `^N^` citation superscripts our citation-extension emits.
    - ReasoningPanel above the content — self-contained collapsible
      with its own click-to-expand header; no toggle needed here.
    - CitationsPanel below the content (collapsed by default; toggled
      via the numbered citations button in the action bar, or opened
      by a body-side citation click which also fires a flash on the
      matching row).
    - The `.msg-actions` row (copy, citations toggle, context ring).

  What it deliberately DOESN'T own:

    - Streaming state — the live bubble in Chat.svelte keeps its own
      reactive state because its open/close transitions are driven by
      "reasoning arrived first, then content started" timing that only
      exists during streaming.
    - The outer `.msg.assistant` wrapper — the tool-group path needs
      to share that wrapper with `<ToolCalls>` cards, so the bubble
      is rendered by the parent.
-->
<script lang="ts">
  import Markdown from './Markdown.svelte';
  import CopyButton from './CopyButton.svelte';
  import ContextRing from './ContextRing.svelte';
  import ReasoningPanel from './ReasoningPanel.svelte';
  import CitationsPanel from './CitationsPanel.svelte';
  import type { Snippet } from 'svelte';
  import type { Message } from '$lib/supabase';
  import { findContextWindowById } from '$lib/models';
  import {
    citationFlashDelay,
    hasCitationRefsInBody,
    isCitationsUnavailable,
    parseCitationRefHref,
    showCitationsControls,
  } from '$lib/ui/assistant-body';

  interface Props {
    content: string;
    reasoning?: string | null;
    citations?: Message['citations'];
    model?: string | null;
    usage?: Message['usage'];
    /**
     * ISO timestamp from `messages.created_at`. Forwarded to
     * ContextRing so the context-window expansion can show when the
     * response was received in the user's local zone.
     */
    createdAt?: string | null;
    /** Tool-group card (ToolCalls component). Rendered between body and actions. */
    children?: Snippet;
    /**
     * Set true when this message is in the regenerate-from-here
     * pending-delete range. Greys the bubble (via the parent's
     * `.msg.disabled` class) and disables every button in the action
     * bar so the user can read what's about to be replaced but can't
     * trigger a parallel action against it. Structural toggles
     * (reasoning panel header, tool-call expand rows, body-side
     * `^N^` clicks) stay live so inspection still works.
     */
    disabled?: boolean;
    /**
     * Click handler for the regenerate button. When omitted the
     * button is hidden, so callers without a meaningful regenerate
     * target (e.g. a future preview pane) just don't pass one.
     */
    onRegenerate?: () => void;
  }

  const {
    content,
    reasoning = null,
    citations = null,
    model = null,
    usage = null,
    createdAt = null,
    children,
    disabled = false,
    onRegenerate,
  }: Props = $props();

  let citationsOpen = $state(false);

  /**
   * One-shot flash signal consumed by CitationsPanel. Bumped every time
   * the user clicks a `^N^` superscript — even the same one twice in a
   * row — so the panel's keyed block re-mounts and re-runs its CSS
   * transition. Null between clicks so the panel is quiescent on open.
   */
  let flashCite = $state<{ index: number; key: number } | null>(null);
  let flashCounter = 0;

  const citationList = $derived(citations ?? []);
  const hasCitations = $derived(citationList.length > 0);
  const hasRefs = $derived(hasCitationRefsInBody(content));
  const citationsUnavailable = $derived(
    isCitationsUnavailable(hasRefs, hasCitations)
  );
  const controlsVisible = $derived(
    showCitationsControls(hasCitations, citationsUnavailable)
  );

  const contextWindow = $derived(
    usage ? findContextWindowById(model ?? undefined) : null
  );

  /**
   * Click delegation for `^N^` citation links inside the markdown
   * render. The citation extension (src/lib/markdown.ts) emits
   * `<a href="#cite-N" class="citation-ref">N</a>`; we intercept the
   * navigation here, expand the panel if it's closed, and schedule
   * a flash on row N for after the slide-down animation completes.
   */
  function onBodyClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a.citation-ref');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    const idx = parseCitationRefHref(anchor.getAttribute('href') ?? '');
    if (idx === null) return;
    const wasOpen = citationsOpen;
    if (!citationsOpen) citationsOpen = true;
    // Orphan-refs case (older rows before the citations column
    // existed): the panel opens to a "sources not saved" notice, so
    // there's no row to flash. Skip the flash scheduling and we
    // avoid passing `flashCite` down into a panel that can't honor
    // it — keeps the "missing sources" affordance from looking like
    // it's half-working.
    if (citationsUnavailable) return;
    // setTimeout rather than `tick()` — Svelte's tick resolves as
    // soon as the state update commits, but the slide transition
    // itself is still in flight. We want the flash to fire AFTER
    // the user's eye has tracked the panel opening, not at the same
    // instant it starts moving.
    window.setTimeout(() => {
      flashCounter += 1;
      flashCite = { index: idx, key: flashCounter };
    }, citationFlashDelay(wasOpen));
  }
</script>

<ReasoningPanel reasoning={reasoning ?? ''} />

<!-- The wrapper is a pure click-delegation host; all actual markup
     is emitted by `<Markdown>`. Same a11y concession as Markdown.svelte
     itself — the anchors inside are native, the wrapper is not an
     interactive surface in its own right. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="assistant-body" onclick={onBodyClick}>
  <Markdown {content} />
</div>

{#if children}
  {@render children()}
{/if}

{#if content}
  <div class="msg-actions">
    <CopyButton text={content} ariaLabel="Copy message" {disabled} />
    {#if controlsVisible}
      <!-- Citations toggle — numbered badge doubles as count AND the
           "source list" affordance. Inline-linked in the markdown as
           `^N^` anchors; this button opens the same panel a direct
           click on one of those would. Orphan-refs case (older rows
           from before we persisted the citations column) renders
           without a count badge and with a "—" style marker so the
           user understands the button will surface a status note,
           not a working source list. -->
      <button
        type="button"
        class="copy-btn citations-toggle"
        class:active={citationsOpen}
        class:unavailable={citationsUnavailable}
        {disabled}
        onclick={() => {
          citationsOpen = !citationsOpen;
        }}
        title={citationsUnavailable
          ? 'Sources not saved on this message'
          : citationsOpen
            ? 'Hide sources'
            : `${citationList.length} source${citationList.length === 1 ? '' : 's'}`}
        aria-label={citationsOpen ? 'Hide sources' : 'Show sources'}
        aria-pressed={citationsOpen}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <!-- Open-book glyph: the "these claims are cited" shorthand
               used by most research UIs. Preferred over a footnote
               superscript because the toggle button is already 14px
               — a footnote glyph that size becomes illegible. -->
          <path d="M2 3h7a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-7a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h8z" />
        </svg>
        {#if hasCitations}
          <span class="badge citation-count">{citationList.length}</span>
        {/if}
      </button>
    {/if}
    {#if usage && contextWindow}
      <ContextRing
        totalTokens={usage.total_tokens}
        contextWindow={contextWindow}
        createdAt={createdAt}
      />
    {/if}
    {#if onRegenerate}
      <!-- Regenerate-from-here. Sits at the right edge of the action
           bar so the destructive control is far from the high-traffic
           Copy button on the left, and so its position is stable
           across messages with and without the citations / context
           ring controls in between. The handler greys this message
           plus every message after it (see Chat.svelte's
           regenerateFrom), then re-runs the chat loop from the user
           message that opened the now-greyed range. The greyed rows
           don't disappear until the new completion lands cleanly -
           an abort or error restores them so nothing is lost. -->
      <button
        type="button"
        class="copy-btn regenerate-btn"
        {disabled}
        onclick={onRegenerate}
        title="Regenerate this response (replaces this and any following messages)"
        aria-label="Regenerate response"
      >
        <!-- Feather "refresh-cw": same glyph used by the rate-limit
             retry button in the inline error bubble. Reusing it keeps
             "this is a re-do" visually consistent across the two
             surfaces that re-fire a request. -->
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
          <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
        </svg>
      </button>
    {/if}
  </div>
{/if}

<CitationsPanel
  citations={citationList}
  open={citationsOpen}
  unavailable={citationsUnavailable}
  {flashCite}
/>

<style>
  /* `.assistant-body` is just a delegation host — no visual styling.
     Keeping the wrapper in the stylesheet so the class name isn't
     orphaned if a future CSS-only theme needs a hook here. */
  .assistant-body {
    display: contents;
  }

  /* Active state on the citations toggle mirrors the hover treatment
     so the opened panel's button reads as "pressed" without a
     separate color — consistent with the toolbox-btn conventions
     elsewhere. */
  .citations-toggle.active {
    color: var(--text);
    background: var(--surface);
    border-color: var(--text);
  }

  /* Positioning shim for the count badge on the citations button.
     .copy-btn's flex centering keeps the SVG glyph centered; the
     badge rides absolute-positioned in the top-right corner so it
     overlays the glyph slightly — the whole button stays 14px wide
     instead of growing with the count. */
  .citations-toggle {
    position: relative;
  }

  .citations-toggle .citation-count {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 1em;
    height: 1em;
    padding: 0 0.25em;
    font-size: 0.65rem;
    font-weight: 600;
    line-height: 1;
    color: var(--bg);
    background: var(--accent);
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* Orphan-refs state: the button is present because the message
     has ^N^ marks, but we have no list to show. Dim the glyph so
     the control reads as "follow-up available, but degraded" — the
     title tooltip + panel contents explain the rest. */
  .citations-toggle.unavailable {
    opacity: 0.55;
  }
  .citations-toggle.unavailable:hover,
  .citations-toggle.unavailable:focus-visible {
    opacity: 1;
  }
</style>
