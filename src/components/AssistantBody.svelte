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

  interface Props {
    content: string;
    reasoning?: string | null;
    citations?: Message['citations'];
    model?: string | null;
    usage?: Message['usage'];
    /** Tool-group card (ToolCalls component). Rendered between body and actions. */
    children?: Snippet;
  }

  const {
    content,
    reasoning = null,
    citations = null,
    model = null,
    usage = null,
    children,
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

  /**
   * True when the message body carries `^N^` / `^i,j^` superscript
   * references — the same pattern the markdown extension matches on.
   * Used to detect the "older row" case: an assistant turn from
   * before we persisted the citations column still has the inline
   * marks, but no source list to expand behind them. In that case
   * we still show the panel and the toggle — just with a "sources
   * weren't saved on this message" note inside — so a click on
   * `^2^` doesn't silently no-op.
   */
  const hasCitationRefsInBody = $derived.by(() => {
    if (!content) return false;
    return /\^\d+(?:\s*,\s*\d+)*\^/.test(content);
  });
  /**
   * Flag rather than a derived of `!hasCitations` alone — a turn
   * with neither refs nor stored citations (the common case) should
   * not surface a toggle or panel at all, only a turn with orphan
   * refs should.
   */
  const citationsUnavailable = $derived(
    hasCitationRefsInBody && !hasCitations
  );
  const showCitationsControls = $derived(hasCitations || citationsUnavailable);

  const contextWindow = $derived(
    usage ? findContextWindowById(model ?? undefined) : null
  );

  /**
   * Click delegation for `^N^` citation links inside the markdown
   * render. The citation extension (src/lib/markdown.ts) emits
   * `<a href="#cite-N" class="citation-ref">N</a>`; we intercept the
   * navigation here, expand the panel if it's closed, and schedule
   * a flash on row N for after the slide-down animation completes.
   *
   * `await tick()` + a 240ms delay covers the 220ms slide transition
   * in CitationsPanel plus a cushion for the layout to settle. Doing
   * the flash earlier would start the highlight while the row is
   * still sliding in, which reads as jank.
   */
  function onBodyClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a.citation-ref');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    const m = /^#cite-(\d+)$/.exec(href);
    if (!m) return;
    const idx = Number(m[1]);
    if (!Number.isFinite(idx)) return;
    const wasOpen = citationsOpen;
    if (!citationsOpen) citationsOpen = true;
    // Orphan-refs case (older rows before the citations column
    // existed): the panel opens to a "sources not saved" notice, so
    // there's no row to flash. Skip the flash scheduling and we
    // avoid passing `flashCite` down into a panel that can't honor
    // it — keeps the "missing sources" affordance from looking like
    // it's half-working.
    if (citationsUnavailable) return;
    const delay = wasOpen ? 0 : 240;
    // setTimeout rather than `tick()` — Svelte's tick resolves as
    // soon as the state update commits, but the slide transition
    // itself is still in flight. We want the flash to fire AFTER
    // the user's eye has tracked the panel opening, not at the same
    // instant it starts moving.
    window.setTimeout(() => {
      flashCounter += 1;
      flashCite = { index: idx, key: flashCounter };
    }, delay);
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
    <CopyButton text={content} ariaLabel="Copy message" />
    {#if showCitationsControls}
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
      <ContextRing totalTokens={usage.total_tokens} contextWindow={contextWindow} />
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
