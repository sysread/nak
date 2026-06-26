<script lang="ts">
  /**
   * Bottom-right indicator that opens the Recall diagnostics modal.
   *
   * Sibling to BiasPill, IntuitionPill, SamskaraToasts, and the
   * scroll-to-bottom arrow - all five absolutely positioned within
   * .messages-wrap (Chat.svelte) and stacking as a vertical column.
   * This pill sits at the top of the column, above the bias chart.
   *
   * Light-bulb glyph because the user's framing for this surface is
   * the "I just remembered something" beat - a memory bulb lighting
   * up before the next reply. U+1F4A1 (ELECTRIC LIGHT BULB) is
   * classified emoji by default so no U+FE0F selector is needed;
   * same font-family cascade caveats as the brain and mood pills
   * apply on older Android WebView.
   *
   * ALWAYS visible. When no cached payload exists for the active
   * thread - cold-start state, no thread selected, or a cached
   * payload with an empty note (both children returned the empty
   * signal this round) - the pill renders disabled / grayed-out
   * rather than disappearing. Same affordance as IntuitionPill:
   * the user learns where the feature lives even when there's
   * nothing to show yet.
   */
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { navigate } from '$lib/routing.svelte';
  import type { ContextRecallPayload } from '$lib/context-recall';

  interface Props {
    /** Cached payload for the active thread, or null when none
     *  exists. A payload whose `note` is empty is treated the same
     *  as null - there's nothing to show in the modal. */
    payload: ContextRecallPayload | null;
  }
  let { payload }: Props = $props();

  const FLY_IN_MS = 220;
  const FLY_OUT_MS = 320;

  const enabled = $derived(
    payload !== null && payload.note.trim().length > 0
  );
</script>

<div class="recall-pill-wrap" aria-live="polite" aria-atomic="true">
  <button
    type="button"
    class="recall-pill"
    class:is-disabled={!enabled}
    disabled={!enabled}
    title={enabled
      ? 'View recall - what Nak remembered before the next reply'
      : 'Recall - no data for this conversation yet'}
    aria-label={enabled
      ? 'Open recall diagnostics'
      : 'Recall diagnostics (no data yet)'}
    onclick={() => {
      if (enabled) navigate({ modal: 'recall' });
    }}
    in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
    out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
  >
    <span class="emoji" aria-hidden="true">&#x1F4A1;</span>
  </button>
</div>

<style>
  /* Top of the bottom-right pill column. The column from top to bottom:
       recall pill (this one)            bottom: calc(--diag-base + 7.5rem)
       intuition pill (brain)            bottom: calc(--diag-base + 5rem)
       bias pill                         bottom: calc(--diag-base + 2.5rem)
       samskara mood pill                bottom: var(--diag-base)
       intents pill (seedling, opt-in)   bottom: 3.6rem
       scroll-to-bottom arrow            bottom: ~1rem
     --diag-base (set on .messages-wrap) is 6.1rem when the intents pill
     occupies the bottom slot and 3.6rem when it doesn't, so the always-
     on pills drop one 2.5rem step and stay flush with the arrow. With
     intents on, this pill sits at 13.6rem; with it off, 11.1rem. The
     2.5rem step is 2.1rem pill height + 0.4rem gap. z-index 25 matches
     the sibling pills: above chat surface, below modals (30) and drawers
     (40). pointer-events:none on the wrap keeps the messages pane
     underneath clickable; the button itself opts back in. */
  .recall-pill-wrap {
    position: absolute;
    bottom: calc(var(--diag-base, 3.6rem) + 7.5rem);
    right: 1rem;
    z-index: 25;
    pointer-events: none;
  }

  .recall-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.1rem;
    height: 2.1rem;
    padding: 0;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    color: var(--text);
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    border-radius: 50%;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
    pointer-events: auto;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  .recall-pill:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  }

  .recall-pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Disabled state. Same posture as IntuitionPill: reduced opacity +
     cursor change signal "feature exists, but no data to surface
     right now" without lying about interactivity. */
  .recall-pill:disabled,
  .recall-pill.is-disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .recall-pill:disabled:hover,
  .recall-pill.is-disabled:hover {
    border-color: color-mix(in srgb, var(--border) 80%, transparent);
  }

  .emoji {
    font-size: 1.1rem;
    line-height: 1;
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }
</style>
