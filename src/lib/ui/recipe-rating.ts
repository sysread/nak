/**
 * UI-behavior primitives for the cookbook's five-star rating
 * control. Pure functions only - no runes, no Svelte imports, no
 * DOM access. The companion `src/components/RecipeRating.svelte`
 * composes these with its own hover rune and markup.
 *
 * The rating domain: 1-5 set, or null for unrated. Zero is not a
 * valid rating anywhere in the schema - clearing returns null so
 * the empty state is honest.
 */

/**
 * Effective rating for rendering. While the cursor previews star N
 * the preview wins; otherwise the persisted value, clamped to 1-5
 * or null. Out-of-range and non-finite persisted values render as
 * unrated (below 1) or pinned to 5 (above), so a bad row never
 * paints a broken star strip.
 */
export function effectiveRating(
  value: number | null | undefined,
  hover: number | null
): number | null {
  if (hover !== null) return hover;
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  if (value < 1) return null;
  if (value > 5) return 5;
  return Math.round(value);
}

/**
 * Next rating after a click on star N. Clicking the already-set
 * rating clears it - without this, the only way to remove a rating
 * from a 1-star recipe would be to set it to a different value
 * first, which doesn't match the user's mental model ("click to
 * toggle off").
 */
export function ratingAfterStarClick(
  value: number | null,
  n: number
): number | null {
  return value === n ? null : n;
}

/**
 * Next rating for a keyboard press, or null when the key is not a
 * rating key (the caller leaves the event alone). Left/right adjust
 * by one; 0 / Backspace / Delete clear. Enter and Space are NOT
 * handled here - they route through the click path so the toggle-off
 * rule applies to the focused star.
 *
 * The result is wrapped in an object so "clear the rating"
 * ({ next: null }) stays distinguishable from "key not handled"
 * (null).
 */
export function ratingAfterKey(
  value: number | null,
  key: string
): { next: number | null } | null {
  if (key === 'ArrowRight') {
    // The trailing || 1 guards the out-of-range persisted value -1,
    // which increments to the falsy 0; every in-range input already
    // lands on 1-5 before it.
    return { next: Math.min(5, (value ?? 0) + 1) || 1 };
  }
  if (key === 'ArrowLeft') {
    const next = (value ?? 0) - 1;
    return { next: next < 1 ? null : next };
  }
  if (key === '0' || key === 'Backspace' || key === 'Delete') {
    return { next: null };
  }
  return null;
}

/** Button label for interactive star N: "Rate 1 star" / "Rate 3 stars". */
export function rateStarLabel(n: number): string {
  return `Rate ${n} ${n === 1 ? 'star' : 'stars'}`;
}

/**
 * Read-only strip's single aria-label, announced once for the whole
 * strip rather than five times per star.
 */
export function ratingAriaLabel(value: number | null): string {
  if (value === null) return 'Unrated';
  return `Rating: ${value} of 5 stars`;
}
