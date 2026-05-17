<script lang="ts">
  /**
   * Bottom-right indicator that opens the Bias Profile diagnostics
   * modal. Sibling to IntuitionPill, SamskaraToasts, and the
   * scroll-to-bottom arrow - all four absolutely positioned within
   * .messages-wrap (Chat.svelte) and stacking as a vertical column.
   * This pill sits at the top of the column, above the intuition
   * brain.
   *
   * Visible only when at least one bias has been observed (the
   * cache has at least one row regardless of tier). On a cold-start
   * user the pill renders nothing - same rule the intuition pill
   * uses, since revealing "we are forming a model of you" before
   * there is any model to inspect is just noise.
   *
   * Icon is U+1F4C8 CHART INCREASING (a single emoji glyph that
   * reads as "patterns / trends"). Stays static regardless of how
   * many biases are soft/strong - the debug modal is where the
   * tier picture lives. The icon being constant is deliberate per
   * the design: a tier-reflective glyph would tell the user that
   * something is currently shaping the system prompt, which we
   * specifically do NOT want them reasoning about turn-by-turn
   * (same "absorption over disclaimer" framing samskara takes).
   */
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { navigate } from '$lib/routing.svelte';

  interface Props {
    /** Number of rows in bias_summary. Zero hides the pill. */
    rowCount: number;
  }
  let { rowCount }: Props = $props();

  const FLY_IN_MS = 220;
  const FLY_OUT_MS = 320;
</script>

<div class="bias-pill-wrap" aria-live="polite" aria-atomic="true">
  {#if rowCount > 0}
    <button
      type="button"
      class="bias-pill"
      title="View bias profile - observed patterns across conversations"
      aria-label="Open bias profile diagnostics"
      onclick={() => navigate({ modal: 'bias-profile' })}
      in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
      out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
    >
      <span class="emoji" aria-hidden="true">&#x1F4C8;</span>
    </button>
  {/if}
</div>

<style>
  /* Stacks above the intuition pill. The column from top to bottom:
       bias pill (this one)             bottom: 8.6rem
       intuition pill (brain)           bottom: 6.1rem
       samskara mood pill               bottom: ~3.6rem
       scroll-to-bottom arrow           bottom: ~1rem
     Each pill is 2.1rem tall; the 0.4rem gap keeps them legible
     without crowding. Same z-index 25 as the others so they share
     the same stacking context above chat surface but below modals
     (30) and drawers (40). pointer-events:none on the wrap so the
     messages pane stays clickable through the gaps; the button
     itself opts back in. */
  .bias-pill-wrap {
    position: absolute;
    bottom: 8.6rem;
    right: 1rem;
    z-index: 25;
    pointer-events: none;
  }

  .bias-pill {
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

  .bias-pill:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  }

  .bias-pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .emoji {
    font-size: 1.1rem;
    line-height: 1;
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }
</style>
