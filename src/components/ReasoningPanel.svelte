<!--
  Reasoning / chain-of-thought panel.

  Sits at the top of an assistant message bubble whenever the turn
  produced `reasoning_content` (OpenAI-compat field; Venice streams it
  on `delta.reasoning_content` for reasoning-capable models). Presents
  as a self-contained collapsible: a compact clickable header (thought-
  balloon icon + "Reasoning" label + chevron) that expands into a
  block-quote-styled body of italic prose.

  The header replaces the old toggle button that used to live in the
  message action bar — keeping the affordance at the top of the bubble
  means the reasoning reads as something that happened BEFORE the
  answer (which is how the model produced it), not a footnote tucked
  under the final text. During streaming the parent opens the panel
  via the bindable `open` prop on the first reasoning delta, then
  auto-collapses it once the thought runs long or the answer starts
  (see reasoningShouldCollapse + Chat.svelte), so the user watches the
  model "think out loud" and then watches the thinking tuck away. A
  manual click is sticky for the rest of the turn - the parent stops
  driving `open` once the user has touched it.

  While streaming, the header carries two pills beside the label - an
  elapsed-ms counter and a running character count - so a collapsed
  panel still shows the thinking is alive and how far along it is. The
  parent passes them only on the live row; persisted rows render the
  header bare (the timing isn't persisted).

  Rendering: dark-grey italic plain text, not markdown. The thinking
  stream is prose the model didn't intend for a user — rendering it
  as markdown tends to produce ugly half-parsed artifacts (a single
  `#` in the middle of a sentence becomes an H1, stray backticks eat
  the tail of the thought). Treating it as a pre-wrap string keeps it
  legible without letting the model accidentally style the transcript.
-->
<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { safeSlide } from '$lib/ui/safe-slide';

  interface Props {
    reasoning: string;
    /**
     * Two-way bindable so the parent (the streaming bubble in
     * Chat.svelte) can pin the panel open while deltas arrive and
     * flip it closed once the answer starts, while persisted rows
     * in AssistantBody can just let the user drive it.
     */
    open?: boolean;
    /**
     * Transition duration for the slide animation. The parent stream
     * path passes a slightly longer value so the "close after first
     * content delta" moment reads as a deliberate gesture rather than
     * a snap.
     */
    duration?: number;
    /**
     * Streaming-only header pills. `elapsedPill` is the thinking-time
     * counter (e.g. "1432 ms"), `charPill` the running length (e.g.
     * "512 chars"). Null on persisted rows, which render the header
     * bare - the timing isn't persisted. Both are pre-formatted by the
     * parent (reasoningElapsedPill / reasoningCharPill).
     */
    elapsedPill?: string | null;
    charPill?: string | null;
    /**
     * Fired when the user clicks the header. The streaming parent uses
     * it to latch "the user took manual control" so its automatic
     * open/collapse stops fighting the click for the rest of the turn.
     * Persisted rows don't pass it - there's no automation to suppress.
     */
    onToggle?: () => void;
  }

  let {
    reasoning,
    open = $bindable(false),
    duration = 220,
    elapsedPill = null,
    charPill = null,
    onToggle,
  }: Props = $props();
</script>

{#if reasoning.length > 0}
  <div class="reasoning" class:open>
    <button
      type="button"
      class="reasoning-header"
      onclick={() => {
        open = !open;
        onToggle?.();
      }}
      aria-expanded={open}
      aria-label={open ? 'Hide reasoning' : 'Show reasoning'}
      title={open ? 'Hide reasoning' : 'Show reasoning'}
    >
      <!-- Cloud-shaped thought balloon with two trailing bubbles.
           Kept consistent with the old action-bar icon so regulars
           who learned the glyph don't have to re-learn it. -->
      <svg
        class="reasoning-icon"
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
        <path
          d="M7 14a4 4 0 0 1-1-7.87A5 5 0 0 1 16 5a4 4 0 0 1 1 7.87 3 3 0 0 1-3 3H8a3 3 0 0 1-1-1z"
        />
        <circle cx="7" cy="19" r="1.2" />
        <circle cx="4" cy="21.5" r="0.7" />
      </svg>
      <span class="reasoning-label">Reasoning</span>
      <!-- Streaming-only pills: thinking-time (ms) + character count.
           Mirror the tool-call duration pill so "how long / how much"
           reads the same across the card. Present only while the parent
           feeds live values; a collapsed panel still shows the thought
           is alive and advancing. aria-hidden - the visible counter is
           decorative progress, not content a screen reader should
           announce on every tick. -->
      {#if elapsedPill}
        <span class="reasoning-pill" aria-hidden="true">{elapsedPill}</span>
      {/if}
      {#if charPill}
        <span class="reasoning-pill" aria-hidden="true">{charPill}</span>
      {/if}
      <!-- Chevron rotates 90° when open — a familiar "disclosure
           triangle" affordance. Animating with CSS rather than Svelte
           transitions so the header never reflows mid-slide. -->
      <svg
        class="reasoning-chevron"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </button>
    {#if open}
      <!-- Block-quote treatment: left accent border + indented italic
           prose. Reads as "someone else's voice" which is apt for a
           chain-of-thought trace — it's the model's inner monologue,
           not part of the reply proper. -->
      <!-- safeSlide, not the raw `slide` transition: this panel auto-closes
           on a timer mid-stream, which can fire while the chat shell is
           display:none behind an open modal. Plain slide measures NaN height
           there and floods the console - see src/lib/ui/safe-slide.ts. -->
      <blockquote
        class="reasoning-body"
        transition:safeSlide={{ duration, easing: cubicOut }}
      >
        {reasoning}
      </blockquote>
    {/if}
  </div>
{/if}

<style>
  /* Container sits above the answer body inside the .msg.assistant
     bubble. Margin below only — the bubble's own top padding is the
     gap above. */
  .reasoning {
    margin-bottom: 0.6rem;
  }

  /* The header IS the toggle. Borderless, muted, padded just enough
     to be a comfortable click target; hover lifts it into `--text`
     so the affordance is obvious without shouting. */
  .reasoning-header {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.5rem;
    margin-left: -0.5rem; /* align the icon with the body's left edge */
    background: transparent;
    border: none;
    border-radius: var(--radius);
    color: var(--muted);
    font: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
  }

  .reasoning-header:hover,
  .reasoning-header:focus-visible {
    background: var(--bg-2);
    color: var(--text);
  }

  .reasoning-icon {
    flex: 0 0 auto;
  }

  /* Streaming header pills - matched to .tool-pill (src/styles.css) so
     the thinking counters read as the same family as the tool-call
     duration pill. tabular-nums + a min-width keep the live ms counter
     from jittering the row as it gains digits. */
  .reasoning-pill {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 0.78rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    min-width: 4.5rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* Chevron rotates from "pointing right" (collapsed) to "pointing
     down" (expanded). 200ms matches the slide's feel without trying
     to sync to the variable `duration` prop — a small drift there
     reads as decoration, not a mismatch. */
  .reasoning-chevron {
    flex: 0 0 auto;
    transition: transform 200ms var(--ease, ease-out);
  }

  .reasoning.open .reasoning-chevron {
    transform: rotate(90deg);
  }

  /* Block-quote body — dark-grey italic per product direction.
     Left border is the block-quote affordance; pre-wrap preserves
     the streamed linebreaks; word-break guards against a long
     un-broken identifier overflowing on narrow viewports. */
  .reasoning-body {
    margin: 0.25rem 0 0;
    padding: 0.35rem 0 0.35rem 0.75rem;
    border-left: 3px solid var(--border);
    color: var(--muted);
    font-style: italic;
    font-size: 0.92rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
