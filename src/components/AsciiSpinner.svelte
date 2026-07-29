<!--
  Text spinner for in-flight rows in the manual librarian-run strips
  (`src/screens/Memories.svelte`, `src/screens/Wiki.svelte`). Cycles a
  short frame sequence on a timer; `variant` picks which one - the
  terminal bar `- \ | /`, or the memory librarian's drowsing `zzz`.

  Why a JS timer instead of the CSS `transform: rotate()` trick the
  chat tool rows use on their U+21BB glyph (`.tool-status.status-pending`
  in styles.css): a spinning single glyph at this size reads as a
  faint shimmer, and the strip's previous pulsing ellipsis was even
  quieter - users could not tell the run was alive. Swapping glyphs
  changes the SHAPE every frame, which the eye catches at any size.
  That is also why the slow `sleep` cadence is safe: what failed
  before was opacity-only motion, not slowness.

  Callers must keep this inside an `aria-hidden` container. Every
  strip call site sits in an `aria-live="polite"` region, and a live
  region announces each mutation inside it - an unhidden spinner would
  read its frame sequence aloud several times a second.

  The span reserves the widest frame's width and left-aligns, so a
  growing sequence never nudges the label beside it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    spinnerFrame,
    spinnerFrameMs,
    spinnerStaticFrame,
    spinnerWidthCh,
    type SpinnerVariant,
  } from '$lib/ui/ascii-spinner';

  let { variant = 'bar' as SpinnerVariant }: { variant?: SpinnerVariant } = $props();

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
    }, spinnerFrameMs(variant));
    return () => clearInterval(id);
  });
</script>

<span class="ascii-spinner" style="width: {spinnerWidthCh(variant)}ch"
  >{animate ? spinnerFrame(tick, variant) : spinnerStaticFrame(variant)}</span
>

<style>
  .ascii-spinner {
    /* Pinned to the mono stack even though the app body already uses
       it - the reserved width is in `ch`, so it only holds the column
       if the glyphs actually advance one cell each. */
    font-family: var(--font-mono);
    display: inline-block;
    text-align: left;
    white-space: pre;
  }
</style>
