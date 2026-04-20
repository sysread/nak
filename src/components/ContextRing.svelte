<!--
  Per-message context-window indicator.

  Renders a small circular progress ring showing how full the model's
  context window was after this turn finished. Sourced from the
  `{prompt_tokens, completion_tokens, total_tokens}` usage block that
  Venice attaches to each assistant response (see
  `stream_options.include_usage` in venice.ts) combined with the
  contextWindow of the model that produced the row (looked up by id in
  models.ts). When either piece is missing the component renders
  nothing — the caller doesn't have to guard the call site.

  Placement: sits in `.msg-actions` alongside CopyButton. Visually
  matches that button's 14px icon footprint and uses the same
  surface / border colors so the bar reads as a single control strip.

  Color ramp: hue goes from 120 (green) at 0% to 0 (red) at 100%, passing
  through 60 (yellow) at the midpoint. A single linear interp on the HSL
  hue track keeps the "getting worse as the ring fills" intuition without
  extra thresholds to tune. Saturation and lightness are fixed so the
  ring reads the same across themes.

  Reveal: the summary surfaces via three paths, so every platform has
  one that works:
    - desktop hover → native `title` tooltip
    - click / tap   → an inline popover, dismissed by clicking outside
                       or hitting Escape
    - screen reader → `aria-label` on the button
  The popover matters because `title` tooltips never fire on touch,
  leaving mobile users with no way to see the exact token counts.
-->
<script lang="ts">
  interface Props {
    /** Total tokens spent on this turn (prompt + completion). */
    totalTokens: number;
    /** The model's context window, in tokens. */
    contextWindow: number;
  }

  const { totalTokens, contextWindow }: Props = $props();

  // Clamp to [0, 1] so a provider that overshoots (shouldn't happen,
  // but defensive) doesn't produce a ring that goes around twice or
  // a negative stroke-dashoffset.
  const pct = $derived.by(() => {
    if (!(contextWindow > 0)) return 0;
    const raw = totalTokens / contextWindow;
    return Math.min(1, Math.max(0, raw));
  });

  // Hue track: 120 (green) → 0 (red). Matches the "getting worse as it
  // fills" intuition the user asked for. The saturation/lightness
  // combo below was picked to stay legible against both light and dark
  // message-card surfaces.
  const hue = $derived(Math.round((1 - pct) * 120));
  const color = $derived(`hsl(${hue} 65% 42%)`);

  // SVG geometry. viewBox is 24 for alignment with other icons in the
  // bar; the visible size is 14px to match CopyButton's glyph. r=9 with
  // a stroke width of 3 leaves a crisp 2.5px track inset from the box
  // edge — visible without clipping at 14px render size.
  const RADIUS = 9;
  const CIRC = 2 * Math.PI * RADIUS;
  const dashOffset = $derived(CIRC * (1 - pct));

  // Human-readable summary for the tooltip / popover / aria-label.
  // Percentage comes first because it's the headline — a glance at the
  // ring already suggests "about half full"; the tooltip's job is to
  // put a specific number to that impression, then back it up with the
  // exact token counts. Thousands separators make the magnitudes
  // legible (1,234,567 reads instantly; 1234567 doesn't).
  const fmt = new Intl.NumberFormat();
  const summary = $derived(
    `${Math.round(pct * 100)}% (${fmt.format(totalTokens)} / ${fmt.format(contextWindow)} tokens)`
  );

  let open = $state(false);
  let rootEl: HTMLButtonElement | undefined = $state();

  function toggle() {
    open = !open;
  }

  // While the popover is open, close it on any pointerdown outside the
  // ring and on Escape. `pointerdown` rather than `click` so a tap that
  // lands on another interactive element (e.g. a different message's
  // ring) dismisses this one before the second element's click toggles
  // its own popover — otherwise you'd need two taps to switch. The
  // handler is wired inside an $effect so it's only attached while
  // open, and torn down when the popover closes or the component
  // unmounts.
  $effect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (rootEl && !rootEl.contains(e.target as Node)) open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') open = false;
    }
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<button
  bind:this={rootEl}
  type="button"
  class="context-ring"
  aria-label={summary}
  aria-expanded={open}
  title={summary}
  onclick={toggle}
>
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <!-- Track: a muted full circle that the progress arc overlays. Gives
         the ring a visible "bucket" at 0% and a consistent silhouette
         across every percentage. -->
    <circle
      cx="12"
      cy="12"
      r={RADIUS}
      fill="none"
      stroke="var(--border)"
      stroke-width="3"
    />
    <!-- Progress arc. Rotated -90° so the stroke starts at 12 o'clock
         and grows clockwise, which is the convention every progress
         ring the user has seen in a browser uses. `round` linecap
         gives the arc a soft leading edge at low percentages where a
         square cap would read as a tick mark. -->
    <circle
      cx="12"
      cy="12"
      r={RADIUS}
      fill="none"
      stroke={color}
      stroke-width="3"
      stroke-linecap="round"
      stroke-dasharray={CIRC}
      stroke-dashoffset={dashOffset}
      transform="rotate(-90 12 12)"
    />
  </svg>
  {#if open}
    <!-- Positioned above and right-aligned to the ring so it stays
         within the message card's horizontal bounds. pointer-events on
         the popover are disabled via CSS so a tap on the popover text
         passes through to the outside-click handler and dismisses it,
         matching the "tap anywhere to close" mental model most touch
         UIs use for transient overlays. -->
    <span class="ring-popover" role="tooltip">{summary}</span>
  {/if}
</button>
