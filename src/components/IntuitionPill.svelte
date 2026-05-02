<script lang="ts">
  /**
   * Top-right indicator that opens the Intuition diagnostics modal.
   *
   * Sibling to SamskaraToasts - same fixed-position posture, offset
   * to the LEFT so the two pills stack horizontally without overlap.
   * The mood pill sits at right ~0.75rem; this one at right ~3.25rem
   * (mood pill's right edge + 2.1rem width + a small gap).
   *
   * Visible whenever a thread is active AND a payload was passed in.
   * On a cold thread (no intuition fired yet) the parent passes null
   * and the pill renders nothing - cleaner than a "no data" pill that
   * would just confuse the user about what was missing.
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
</script>

<div class="intuition-pill-wrap" aria-live="polite" aria-atomic="true">
  {#if payload}
    <button
      type="button"
      class="intuition-pill"
      title="View intuition - perception, drives, synthesis"
      aria-label="Open intuition diagnostics"
      onclick={() => navigate({ modal: 'intuition' })}
      in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
      out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
    >
      <span class="emoji" aria-hidden="true">&#x1F9E0;</span>
    </button>
  {/if}
</div>

<style>
  /* Sits to the left of SamskaraToasts, same vertical position. The
     mood pill is at right: env(...) + 0.75rem with a 2.1rem width;
     this sits at right: env(...) + 0.75rem + 2.1rem + 0.4rem = ~3.25rem
     so the two pills never overlap. */
  .intuition-pill-wrap {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 3rem);
    right: calc(env(safe-area-inset-right, 0px) + 3.25rem);
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

  .emoji {
    font-size: 1.1rem;
    line-height: 1;
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }
</style>
