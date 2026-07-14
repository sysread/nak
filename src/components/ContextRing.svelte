<!--
  Per-message context-window indicator.

  Renders a small circular progress ring showing how much of the
  thread's CURRENT model context window this turn's tokens represent.
  Sourced from the `{prompt_tokens, completion_tokens, total_tokens}`
  usage block that Venice attaches to each assistant response (see
  `stream_options.include_usage` in venice.ts) combined with the
  contextWindow the caller passes in - the window of the model the
  thread resolves to NOW, not whatever model historically answered the
  row. (AssistantBody sources it from the effective tier spec.) The ring
  is a budget indicator for the conversation as it stands; measuring old
  rows against the current window is the point, not a compromise. When
  either piece is missing the component renders nothing — the caller
  doesn't have to guard the call site.

  Placement: sits in `.msg-actions` alongside CopyButton. Visually
  matches that button's 14px icon footprint and uses the same
  surface / border colors so the bar reads as a single control strip.

  Color ramp: hue goes from 120 (green) at 0% to 0 (red) at 100%, passing
  through 60 (yellow) at the midpoint. A single linear interp on the HSL
  hue track keeps the "getting worse as the ring fills" intuition without
  extra thresholds to tune. Saturation and lightness are fixed so the
  ring reads the same across themes.

  Reveal: the ring itself is a toggle. Clicking it slides a detail row
  open right below the action bar with the exact summary plus the
  wall-clock time the assistant row was persisted (the closest signal
  we keep to "when the response was received" - see Message.created_at
  in supabase.ts). Clicking again (or hitting Escape) slides it
  closed. The action bar uses `flex-wrap: wrap` and the detail row
  takes `flex-basis: 100%`, so it naturally drops to its own line
  inside the bubble rather than floating on top of the message. The
  `.ring-detail` rule in styles.css also pins `order: 1` on the row
  so it always lands below every action button, not between the ring
  and any sibling button (e.g. regenerate) that comes after it in DOM
  order — without that, wrapping splits the bar across three lines
  instead of two. Desktop hover still shows a native `title` tooltip
  for a quick peek without a click, and screen readers read the same
  summary via `aria-label`.

  Timezone: timestamps render in `app.displayTimezone`, which is the
  user's setting from Supabase profiles when present and the
  browser-detected zone otherwise (state.svelte.ts seeds it via
  detectTimezone() on activate, before any unlock). Either way the
  field is always populated, so we don't need a fallback chain here.
-->
<script lang="ts">
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { app } from '$lib/state.svelte';
  import {
    clampedPct,
    formatReceivedAt,
    pctToRingColor,
    usageSummary,
    usageTooltip,
  } from '$lib/ui/context-ring';

  interface Props {
    /** Total tokens spent on this turn (prompt + completion). */
    totalTokens: number;
    /** The model's context window, in tokens. */
    contextWindow: number;
    /**
     * ISO-8601 timestamp from `messages.created_at` for the row this
     * ring annotates. Rendered in the slide-down detail row so the
     * user can see when the response landed without leaving the
     * thread. Optional because non-message callers (none today, but
     * possible) can still display the ring without a row.
     */
    createdAt?: string | null;
  }

  const { totalTokens, contextWindow, createdAt = null }: Props = $props();

  const pct = $derived(clampedPct(totalTokens, contextWindow));
  const color = $derived(pctToRingColor(pct));

  // SVG geometry. viewBox is 24 for alignment with other icons in the
  // bar; the visible size is 14px to match CopyButton's glyph. r=9 with
  // a stroke width of 3 leaves a crisp 2.5px track inset from the box
  // edge — visible without clipping at 14px render size.
  const RADIUS = 9;
  const CIRC = 2 * Math.PI * RADIUS;
  const dashOffset = $derived(CIRC * (1 - pct));

  const summary = $derived(usageSummary(totalTokens, contextWindow));
  const receivedAt = $derived(formatReceivedAt(createdAt, app.displayTimezone));
  const tooltip = $derived(usageTooltip(summary, receivedAt));

  let open = $state(false);
  let detailEl = $state<HTMLDivElement | null>(null);
  function toggle() {
    open = !open;
  }

  // Escape closes the detail row, matching the dismissal affordance
  // every expanding control in the app uses. Listener is only
  // attached while open so we don't pay for it on every rendered
  // message in a long thread.
  $effect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') open = false;
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // When a user taps the ring on a message near the bottom edge of
  // the viewport, the newly-revealed detail row can slide past the
  // fold — leaving them staring at the same pre-click scroll position
  // with no visible confirmation anything happened. Wait for the
  // slide-down to finish (so the element has its final height before
  // we measure) then nudge it into view. `block: 'nearest'` only
  // scrolls when the row is actually off-screen, so clicking a ring
  // already in view stays still.
  function onIntroEnd() {
    detailEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
</script>

<button
  type="button"
  class="context-ring"
  aria-label={tooltip}
  aria-expanded={open}
  title={tooltip}
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
         across every percentage. --ring-track rather than --border
         because the terminal style sets --border transparent, which
         would erase the track and leave the arc floating as a bare
         dot; the token defaults to --border in the soft style and is
         overridden per style in styles.css. -->
    <circle
      cx="12"
      cy="12"
      r={RADIUS}
      fill="none"
      stroke="var(--ring-track)"
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
</button>
{#if open}
  <!-- Sibling of .context-ring inside .msg-actions. `flex-basis: 100%`
       plus `order: 1` (see .ring-detail in styles.css) on this row,
       combined with `flex-wrap: wrap` on the parent bar, breaks it
       onto its own line below every action button — even buttons
       that come after the ring in DOM order. Svelte's slide
       transition animates height (plus margin/padding), and cubicOut
       decelerates the motion toward the end so the row settles
       rather than snapping. 220ms is long enough to read as "moving"
       without feeling sluggish on a repeated open/close. -->
  <div
    bind:this={detailEl}
    class="ring-detail"
    role="region"
    aria-label="Context window usage"
    transition:slide={{ duration: 220, easing: cubicOut }}
    onintroend={onIntroEnd}
  >
    <div>{summary}</div>
    {#if receivedAt}
      <!-- "Received" rather than "Sent" because the timestamp is the
           moment the assistant row landed in the messages table, not
           when the user submitted. Closest signal we keep to "the LLM
           response was received at X" - we don't separately record
           the SSE-completion instant. -->
      <div class="ring-detail-received">Received {receivedAt}</div>
    {/if}
  </div>
{/if}
