<!--
  Text spinner for in-flight wiki-agent surfaces: the librarian-run
  strip's step rows (`src/screens/Wiki.svelte`) and the Skipped
  panel's Retrying button (`src/components/WikiSkippedPanel.svelte`).
  The memory strip uses `SleepSpinner.svelte` instead. Cycles the
  classic terminal bar frames `- \ | /` on a timer.

  Why a JS timer instead of the CSS `transform: rotate()` trick the
  chat tool rows use on their U+21BB glyph (`.tool-status.status-pending`
  in styles.css): a spinning single glyph at this size reads as a
  faint shimmer, and the strip's previous pulsing ellipsis was even
  quieter - users could not tell the run was alive. Swapping glyphs
  changes the shape every 100ms, which the eye catches at any size.

  Callers must keep this inside an `aria-hidden` container. Both strip
  call sites sit in an `aria-live="polite"` region, and a live region
  announces every mutation inside it - an unhidden spinner would read
  the frame sequence aloud ten times a second.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    SPINNER_FRAME_MS,
    SPINNER_STATIC_FRAME,
    spinnerFrame,
  } from '$lib/ui/ascii-spinner';

  let tick = $state(0);
  let animate = $state(false);

  onMount(() => {
    // Sampled once rather than watched: a user flipping the OS
    // reduced-motion setting mid-run gets the old behaviour until the
    // next run, which is not worth a listener's teardown surface.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    animate = true;
    const id = setInterval(() => {
      tick += 1;
    }, SPINNER_FRAME_MS);
    return () => clearInterval(id);
  });
</script>

<span class="ascii-spinner"
  >{animate ? spinnerFrame(tick) : SPINNER_STATIC_FRAME}</span
>

<style>
  .ascii-spinner {
    /* Pinned to the mono stack even though the app body already uses
       it - the frames only hold their column if every glyph advances
       the same width, so this must not depend on an ancestor's font. */
    font-family: var(--font-mono);
    display: inline-block;
    width: 1ch;
    text-align: center;
  }
</style>
