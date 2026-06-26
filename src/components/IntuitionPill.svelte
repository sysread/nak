<script lang="ts">
  /**
   * Bottom-right indicator that opens the Intuition diagnostics modal.
   *
   * Sibling to SamskaraToasts and the .scroll-to-bottom arrow - all
   * three are absolutely positioned within .messages-wrap (Chat.svelte)
   * and stack as a vertical column at the bottom-right of the messages
   * pane. This pill sits at the top of the column, above the mood pill
   * and the scroll arrow. Mounting inside .messages-wrap (rather than
   * as a viewport-fixed pill) is what keeps the column aligned with
   * the scroll arrow regardless of composer height.
   *
   * ALWAYS visible. When no cached payload exists for the active thread
   * (cold-start state, or no thread selected) the pill renders in a
   * disabled / grayed-out state instead of disappearing entirely.
   * The disabled-but-visible affordance is better UX than the prior
   * hide-on-empty design: the user knows the feature exists and where
   * to find it once data lands.
   *
   * The icon is a brain glyph (U+1F9E0). Same emoji-presentation
   * caveats apply as the mood pill: U+1F9E0 is classified emoji by
   * default so no U+FE0F selector is needed, but the font-family
   * cascade matters on older Android WebView.
   */
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { navigate } from '$lib/routing.svelte';
  import type { IntuitionPayload } from '$lib/intuition';

  interface Props {
    /** Cached payload for the active thread, or null when none exists. */
    payload: IntuitionPayload | null;
  }
  let { payload }: Props = $props();

  const FLY_IN_MS = 220;
  const FLY_OUT_MS = 320;

  const enabled = $derived(payload !== null);
</script>

<div class="intuition-pill-wrap" aria-live="polite" aria-atomic="true">
  <button
    type="button"
    class="intuition-pill"
    class:is-disabled={!enabled}
    disabled={!enabled}
    title={enabled
      ? 'View intuition - perception, drives, synthesis'
      : 'Intuition - no data for this conversation yet'}
    aria-label={enabled
      ? 'Open intuition diagnostics'
      : 'Intuition diagnostics (no data yet)'}
    onclick={() => {
      if (enabled) navigate({ modal: 'intuition' });
    }}
    in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
    out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
  >
    <span class="emoji" aria-hidden="true">&#x1F9E0;</span>
  </button>
</div>

<style>
  /* Second from the top of the bottom-right pill column, between the
     recall bulb above and the bias pill below. Sits at calc(--diag-base
     + 5rem): 11.1rem when the intents pill takes the bottom slot
     (--diag-base 6.1rem), 8.6rem when intents is off (--diag-base
     3.6rem). The 5rem offset is two 2.5rem steps (2.1rem pill height +
     0.4rem gap each). Right-anchored at 1rem; the 0.05rem horizontal
     offset between the 2.1rem pills and the 2.2rem arrow is below
     perceptual threshold. z-index 25 matches the sibling pills: above
     chat surface, below modals (30) and drawers (40). pointer-events:
     none on the wrap keeps the messages pane underneath clickable; the
     button itself opts back in. */
  .intuition-pill-wrap {
    position: absolute;
    bottom: calc(var(--diag-base, 3.6rem) + 5rem);
    right: 1rem;
    z-index: 25;
    pointer-events: none;
  }

  .intuition-pill {
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

  .intuition-pill:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  }

  .intuition-pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Disabled state. Reduced opacity + cursor change signals "feature
     exists, but no data to surface right now" without lying about
     interactivity (the button is genuinely non-interactive thanks
     to the disabled attribute - no click handler fires). Border
     and shadow stay so the user can still tell where the affordance
     sits; only the contents fade. */
  .intuition-pill:disabled,
  .intuition-pill.is-disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .intuition-pill:disabled:hover,
  .intuition-pill.is-disabled:hover {
    border-color: color-mix(in srgb, var(--border) 80%, transparent);
  }

  .emoji {
    font-size: 1.1rem;
    line-height: 1;
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }
</style>
