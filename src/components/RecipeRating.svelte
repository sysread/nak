<!--
  Five-star rating control for the cookbook. Two modes:

    - Interactive when `onChange` is provided. Clicking star N sets the
      rating to N; clicking the currently-active highest star clears
      back to null (unrated). Hover preview shows what value a click
      would land on, so the user can see the target before committing.
    - Read-only when `onChange` is omitted. Renders the same stars but
      with no buttons, no hover state, no tab stops.

  `null` means "unrated" everywhere - distinguishable from zero (which
  the schema doesn't allow) so the empty state is honest. The widget
  itself never returns 0; clearing returns null.

  Accessibility: each interactive star is a button with an aria-label
  ("Rate N stars"); the active rating's button takes aria-pressed.
  Read-only mode exposes the rating via a single role="img" with an
  aria-label like "Rating: 4 of 5 stars" (or "Unrated").
-->
<script lang="ts">
  interface Props {
    /** 1-5, or null for unrated. Values outside that range render as null. */
    value: number | null;
    /**
     * Optional change handler. Presence flips the widget from
     * read-only to interactive. Receives the new rating - 1-5 for a
     * set, or null for a clear.
     */
    onChange?: (next: number | null) => void;
    /** Glyph size in px. Defaults to 18, the size used in list rows. */
    size?: number;
  }
  let { value, onChange, size = 18 }: Props = $props();

  // Hover preview: while the cursor is on star N, show stars 1..N as
  // active even if `value` says otherwise. Cleared on mouseleave so the
  // resting state matches the persisted rating again.
  let hoverIndex = $state<number | null>(null);

  const interactive = $derived(typeof onChange === 'function');

  // Effective rating for rendering. While hovering, the preview wins;
  // otherwise the persisted value (clamped to 1-5 or null).
  const effective = $derived.by<number | null>(() => {
    if (hoverIndex !== null) return hoverIndex;
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value)) return null;
    if (value < 1) return null;
    if (value > 5) return 5;
    return Math.round(value);
  });

  function onStarClick(n: number): void {
    if (!onChange) return;
    // Clicking the already-set rating clears it. Without this, the only
    // way to remove a rating from a 1-star recipe would be to set it to
    // a different value first, which doesn't match the user's mental
    // model ("click to toggle off").
    if (value === n) onChange(null);
    else onChange(n);
  }

  function onMouseLeaveRow(): void {
    hoverIndex = null;
  }

  // Keyboard: left/right adjust by one, 0 / Backspace / Delete clear.
  // Wired on each star button so focus stays in the group; the global
  // window keydown for Escape in Cookbook.svelte still bails the
  // modal as before.
  function onKeydown(e: KeyboardEvent, n: number): void {
    if (!onChange) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(Math.min(5, (value ?? 0) + 1) || 1);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = (value ?? 0) - 1;
      onChange(next < 1 ? null : next);
      return;
    }
    if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      onChange(null);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onStarClick(n);
    }
  }

  function ariaLabelForValue(v: number | null): string {
    if (v === null) return 'Unrated';
    return `Rating: ${v} of 5 stars`;
  }
</script>

{#if interactive}
  <!-- Interactive group. Each star is a real <button> so it picks up
       the project's button-reset and focus-visible styling. -->
  <span
    class="rating"
    style:--rating-size="{size}px"
    onmouseleave={onMouseLeaveRow}
    role="group"
    aria-label="Recipe rating"
  >
    {#each [1, 2, 3, 4, 5] as n (n)}
      {@const filled = effective !== null && n <= effective}
      <button
        type="button"
        class="rating-star"
        class:is-filled={filled}
        class:is-pressed={value === n}
        aria-label={`Rate ${n} ${n === 1 ? 'star' : 'stars'}`}
        aria-pressed={value === n}
        title={`Rate ${n} ${n === 1 ? 'star' : 'stars'}`}
        onclick={() => onStarClick(n)}
        onkeydown={(e) => onKeydown(e, n)}
        onmouseenter={() => (hoverIndex = n)}
        onfocus={() => (hoverIndex = n)}
        onblur={() => (hoverIndex = null)}
      >
        <!-- Single SVG, two states. `is-filled` flips fill on; resting
             outline is a thin --muted stroke so unrated stars read
             clearly without competing with the recipe content. -->
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polygon
            points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
          />
        </svg>
      </button>
    {/each}
  </span>
{:else}
  <!-- Read-only. Stars render as inline SVGs with no interactivity.
       The whole strip carries one aria-label so screen readers
       announce the rating once, not five times. -->
  <span
    class="rating rating-static"
    style:--rating-size="{size}px"
    role="img"
    aria-label={ariaLabelForValue(value)}
  >
    {#each [1, 2, 3, 4, 5] as n (n)}
      {@const filled = effective !== null && n <= effective}
      <svg
        class="rating-star is-static"
        class:is-filled={filled}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polygon
          points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
        />
      </svg>
    {/each}
  </span>
{/if}

<style>
  .rating {
    display: inline-flex;
    align-items: center;
    gap: 0.1rem;
    line-height: 1;
  }
  .rating-star {
    background: transparent;
    border: none;
    padding: 0.1rem;
    cursor: pointer;
    color: var(--muted);
    border-radius: 4px;
    line-height: 0;
  }
  .rating-star:hover,
  .rating-star:focus-visible {
    color: var(--accent);
    background: var(--accent-weak);
  }
  /* Filled state - accent fill plus the same accent stroke. Applied via
     class on either the <button> (interactive) or the inline <svg>
     (static), so the same rule covers both modes. */
  .rating-star.is-filled,
  .rating-star.is-filled svg,
  svg.rating-star.is-filled {
    color: var(--accent);
  }
  .rating-star.is-filled svg polygon,
  svg.rating-star.is-filled polygon {
    fill: var(--accent);
  }
  /* Static (read-only) variant. No hover, no pointer. The svg itself
     is the "star" - no wrapping <button>. */
  svg.rating-star.is-static {
    color: var(--muted);
    cursor: default;
    padding: 0;
  }
</style>
