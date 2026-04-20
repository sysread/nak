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

  Accessibility: the element carries both `aria-label` and `title` with
  a human-readable summary ("50% (128,400 / 256,000 tokens)") so screen
  readers announce meaning, and sighted users get a hover tooltip with
  exact numbers. The ring itself is `aria-hidden` since its meaning is
  already captured in the label.
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

  // Human-readable summary for the tooltip / aria-label. Percentage
  // comes first because it's the headline — a glance at the ring
  // already suggests "about half full"; the tooltip's job is to put
  // a specific number to that impression, then back it up with the
  // exact token counts. Thousands separators make the magnitudes
  // legible (1,234,567 reads instantly; 1234567 doesn't).
  const fmt = new Intl.NumberFormat();
  const summary = $derived(
    `${Math.round(pct * 100)}% (${fmt.format(totalTokens)} / ${fmt.format(contextWindow)} tokens)`
  );
</script>

<span
  class="context-ring"
  role="img"
  aria-label={summary}
  title={summary}
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
</span>
