<script lang="ts">
  /*
   * Scanner — a K.I.T.T.-style back-and-forth pulser. Five thick vertical
   * bars brighten and dim in sequence at full height, sweeping left-to-
   * right and then right-to-left on a loop, after the segmented red
   * grille on the front of K.I.T.T. in the show. Used anywhere the app
   * has a short-lived "something's happening, no useful progress signal
   * yet" moment - the composer's pre-first-token gap, the auto-title
   * generation, etc.
   *
   * The `label` prop becomes the aria-label so screen readers hear what
   * we're waiting on rather than nothing. The `size` prop scales the
   * whole thing in em units so it inherits the caller's font size by
   * default.
   */
  interface Props {
    label?: string;
    size?: number; // em multiplier; default 1
  }
  let { label = 'Loading', size = 1 }: Props = $props();

  // Derived so the inline `--scanner-scale` stays in sync if a caller
  // binds `size` reactively (rare, but cheap to support).
  const style = $derived(`--scanner-scale:${size}`);
</script>

<span
  class="scanner"
  role="status"
  aria-live="polite"
  aria-label={label}
  {style}
>
  <span></span><span></span><span></span><span></span><span></span>
  <span class="sr-only">{label}</span>
</span>
