<script lang="ts">
  /**
   * Bottom-right indicator that opens the Intents inspector - the
   * read-only "surfaced" surface for the intents feature. Sibling to
   * RecallPill, BiasPill, IntuitionPill, and SamskaraToasts, stacking
   * as a vertical column in .messages-wrap (Chat.svelte). Sits at the
   * TOP of the column (above the recall bulb).
   *
   * Mounted only when intents are enabled (Chat gates with
   * `app.intentsEnabled`), so the off-by-default majority never see it
   * and the column stays uncluttered. Turning the feature on surfaces
   * the inspector immediately - the modal explains the empty state
   * until the first daily pass forms something.
   *
   * Icon is U+1F331 SEEDLING - the growth framing, distinct from the
   * other pills' glyphs. Static regardless of how many intentions are
   * active: like the bias pill, a count-reflective glyph would invite
   * turn-by-turn reasoning about what is shaping the reply, which the
   * "absorption over disclaimer" framing avoids. The inspector is where
   * the picture lives.
   */
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { navigate } from '$lib/routing.svelte';

  const FLY_IN_MS = 220;
  const FLY_OUT_MS = 320;
</script>

<div class="intents-pill-wrap" aria-live="polite" aria-atomic="true">
  <button
    type="button"
    class="intents-pill"
    title="View working intentions - what Nak is working toward with you"
    aria-label="Open working intentions inspector"
    onclick={() => navigate({ modal: 'intents' })}
    in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
    out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
  >
    <span class="emoji" aria-hidden="true">&#x1F331;</span>
  </button>
</div>

<style>
  /* Bottom-most slot of the bottom-right pill column, directly above the
     scroll-to-bottom arrow (arrow at bottom: 1rem + 2.2rem footprint +
     0.4rem gap = 3.6rem). Conditionally mounted, so when intents are off
     there is simply nothing here; .messages-wrap then sets --diag-base to
     3.6rem so the always-on pills (samskara mood up to recall) drop one
     2.5rem step and stay flush with the arrow rather than leaving this
     slot as a gap. Same 2.1rem size, z-index 25, and pointer-events
     handling as its siblings. */
  .intents-pill-wrap {
    position: absolute;
    bottom: 3.6rem;
    right: 1rem;
    z-index: 25;
    pointer-events: none;
  }

  .intents-pill {
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

  .intents-pill:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  }

  .intents-pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .emoji {
    font-size: 1.1rem;
    line-height: 1;
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }
</style>
