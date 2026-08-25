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
  import SecondThoughtsPanel from './SecondThoughtsPanel.svelte';
  import type { Snippet } from 'svelte';
  import type { Message } from '$lib/supabase';
  import { app } from '$lib/state.svelte';
  import {
    citationFlashDelay,
    citationsToggleTitle,
    hasCitationRefsInBody,
    isCitationsUnavailable,
    parseCitationRefHref,
    showCitationsControls,
    showMessageActions,
  } from '$lib/ui/assistant-body';
  import { coerceSecondThoughts, isDoubt } from '$lib/ui/second-thoughts';
  import { webCitationToDisplay } from '$lib/ui/citations';
  import { formatMessageStamp } from '$lib/ui/message-timestamp';

  interface Props {
    content: string;
    reasoning?: string | null;
    /**
     * Pre-formatted reasoning header pills (elapsed-ms + char count),
     * captured while this row streamed and forwarded to ReasoningPanel.
     * Null on rows that didn't stream this session (a cold reopen has
     * no in-memory timing), which render the header bare - same as the
     * tool-duration pills. See `reasoningPillsById` in Chat.svelte.
     */
    reasoningElapsed?: string | null;
    reasoningChars?: string | null;
    citations?: Message['citations'];
    /**
     * Raw `messages.second_thoughts` jsonb for this assistant row. The
     * reviewer agent's self-doubt verdict, arriving on the messages
     * UPDATE echo a beat after the reply commits. Coerced here; the
     * panel renders only when it parses to a real verdict. Absent on
     * user/tool rows, older rows, and turns the reviewer skipped.
     */
    secondThoughts?: unknown;
    /**
     * Fired when the user clicks the second-thoughts refinement button.
     * Passed ONLY for the thread's latest assistant row (the actionable
     * one); when omitted the panel shows no button and doesn't
     * auto-expand. See Chat.svelte `refineFrom`.
     */
    onRefine?: () => void;
    /**
     * Context window (tokens) of the thread's CURRENT model, for the
     * usage ring's denominator. Deliberately the current model's window,
     * not the window of whatever model historically answered this row:
     * the ring is a budget indicator for the conversation as it stands,
     * and the current model is the one whose limit the user has to manage.
     * A row whose turn was larger than today's window fills the ring to
     * full (the arc clamps) and the detail shows the raw counts exceeding
     * the window - a useful "this thread no longer fits the current model"
     * signal. Null hides the ring.
     */
    contextWindow?: number | null;
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
     * Set true when the user can't trigger a mutating/parallel
     * action against this row: either it's in the regenerate-from-here
     * pending-delete range (greyed via the parent's `.regen-target`
     * class so the user can read what's about to be replaced), or a
     * send is in flight on this thread. Disables the Copy and
     * Regenerate buttons in the action bar.
     *
     * Inspection affordances stay live regardless: the reasoning
     * panel header, tool-call expand rows, body-side `^N^` clicks,
     * AND the citations toggle. The toggle and the `^N^` superscripts
     * are two entry points to the same read-only citations panel -
     * gating one but not the other would let a click on `^2^` open
     * sources while the button next to it sits dead, which reads as
     * broken. Sources are safe to read while a row is being replaced
     * or while the next turn streams.
     */
    disabled?: boolean;
    /**
     * Click handler for the regenerate button. When omitted the
     * button is hidden, so callers without a meaningful regenerate
     * target (e.g. a future preview pane) just don't pass one.
     */
    onRegenerate?: () => void;
    /**
     * Fired when the user hovers or focuses the Regenerate button.
     * The caller paints a .regen-target preview on every row that
     * would be replaced if the click landed. Pure UI affordance:
     * never commits state, never reaches the chat loop. When omitted
     * the preview just doesn't render. Paired with
     * `onRegeneratePreviewLeave` which clears the preview.
     */
    onRegeneratePreviewEnter?: () => void;
    onRegeneratePreviewLeave?: () => void;
    /**
     * Click handler for the fork button. Hidden when omitted - the
     * caller passes it only on rows that can anchor a fork (settled
     * terminal assistant rows; see canForkAtMessage in
     * src/lib/ui/fork.ts). User rows get their fork button directly
     * in Chat.svelte, same split as the delete-from-here button.
     */
    onFork?: () => void;
    /**
     * Hover/focus preview for the fork button. Unlike the regenerate
     * preview, the outlined rows are not doomed - they simply stay in
     * this conversation while the fork copies everything above them.
     * The tooltip copy carries that difference; the outline itself
     * reuses the shared regen-preview channel.
     */
    onForkPreviewEnter?: () => void;
    onForkPreviewLeave?: () => void;
  }

  const {
    content,
    reasoning = null,
    reasoningElapsed = null,
    reasoningChars = null,
    citations = null,
    secondThoughts = null,
    onRefine,
    contextWindow = null,
    usage = null,
    createdAt = null,
    children,
    disabled = false,
    onRegenerate,
    onRegeneratePreviewEnter,
    onRegeneratePreviewLeave,
    onFork,
    onForkPreviewEnter,
    onForkPreviewLeave,
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

  const citationList = $derived((citations ?? []).map(webCitationToDisplay));
  const hasCitations = $derived(citationList.length > 0);
  const hasRefs = $derived(hasCitationRefsInBody(content));
  const citationsUnavailable = $derived(
    isCitationsUnavailable(hasRefs, hasCitations)
  );
  const controlsVisible = $derived(
    showCitationsControls(hasCitations, citationsUnavailable)
  );

  const stamp = $derived(formatMessageStamp(createdAt, app.displayTimezone));

  // Coerce the raw jsonb once; null means "no verdict" -> render
  // nothing. The panel shows ONLY for a doubt - conviction (the common
  // "stands by it" verdict) stays silent so the transcript isn't
  // chromed with a calm row on every fine answer, and a visible panel
  // always means something. See src/lib/ui/second-thoughts.ts.
  const secondThoughtsVerdict = $derived(coerceSecondThoughts(secondThoughts));
  const showSecondThoughts = $derived(
    secondThoughtsVerdict !== null && isDoubt(secondThoughtsVerdict.disposition)
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

<ReasoningPanel
  reasoning={reasoning ?? ''}
  elapsedPill={reasoningElapsed}
  charPill={reasoningChars}
/>

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

<!-- Second-thoughts coda: the reviewer's afterthought about this
     answer, below the body (and any tool cards) but above the meta
     action bar. Renders only when the jsonb coerced to a real verdict. -->
{#if showSecondThoughts && secondThoughtsVerdict}
  <SecondThoughtsPanel verdict={secondThoughtsVerdict} {onRefine} {disabled} />
{/if}

<!-- The action bar renders whenever there is content OR a regenerate
     target - a turn aborted mid-tool-call persists an assistant row
     with tool_calls but empty content, and that row still needs its
     regenerate escape hatch. See showMessageActions for the full
     rationale; content-dependent controls (copy, citations) still
     gate on content individually. -->
{#if showMessageActions(content, onRegenerate !== undefined)}
  <div class="msg-actions">
    {#if stamp}
      <!-- Left-aligned timestamp. `margin-right: auto` on `.msg-time`
           absorbs the free space so the action buttons stay pinned to
           the right edge of the bar. -->
      <span class="msg-time">{stamp}</span>
    {/if}
    {#if content}
      <CopyButton text={content} ariaLabel="Copy message" {disabled} />
    {/if}
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
        onclick={() => {
          citationsOpen = !citationsOpen;
        }}
        title={citationsToggleTitle(citationsOpen, citationsUnavailable, citationList.length)}
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
    {#if onFork}
      <!-- Fork-from-here. Copies the conversation up to and including
           this message into a new conversation and opens it; nothing
           in this one is touched. Sits left of Regenerate so the
           destructive control keeps the right edge. -->
      <button
        type="button"
        class="copy-btn fork-btn"
        {disabled}
        onclick={onFork}
        onmouseenter={onForkPreviewEnter}
        onmouseleave={onForkPreviewLeave}
        onfocus={onForkPreviewEnter}
        onblur={onForkPreviewLeave}
        title="Fork here - later messages stay in this conversation"
        aria-label="Fork the conversation at this message"
      >
        <!-- Feather "git-branch": same glyph as the drawer's fork
             indicator, in the action row's 14px / 2px-stroke outline
             language. -->
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
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </button>
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
        onmouseenter={onRegeneratePreviewEnter}
        onmouseleave={onRegeneratePreviewLeave}
        onfocus={onRegeneratePreviewEnter}
        onblur={onRegeneratePreviewLeave}
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
    border-radius: var(--radius-pill);
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
