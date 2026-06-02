/**
 * UI-behavior primitives for the cookbook detail pane. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/screens/Cookbook.svelte` composes these into its
 * detail-header markup.
 *
 * The `Recipe` row shape comes from `$lib/supabase`; that is a
 * domain type, not a framework type, so it is fair game to share
 * with a port.
 */
import type { Recipe } from '../supabase';

/**
 * Tagged union for the recipe's "source" line under the title.
 * `Cookbook.svelte` dispatches on `kind`:
 *
 *   - `none` - neither a source name nor a URL; the line is omitted.
 *   - `text` - a source name with no URL; plain text, no anchor.
 *   - `link` - a URL is present; rendered as a single short anchor
 *     whose visible text is `label`, never the raw URL.
 */
export type RecipeSourceLine =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'link'; label: string; url: string };

/**
 * Collapse a recipe's `source` / `source_url` pair into the source
 * line's view model.
 *
 * The visible anchor text is the source NAME when there is one
 * (markdown `[NYT Cooking](url)` style) and the literal "Source"
 * otherwise. We never render `source_url` verbatim: a bare recipe
 * URL is long enough to span the whole app width on a narrow
 * viewport, pushing the layout out and forcing a horizontal
 * scroll. A short label keeps the line bounded.
 *
 * Whitespace-only `source` is treated as absent so a row carrying
 * an empty string does not produce a blank link label.
 */
export function recipeSourceLine(recipe: Recipe): RecipeSourceLine {
  const name = recipe.source?.trim() || '';
  const url = recipe.source_url?.trim() || '';
  if (url) return { kind: 'link', label: name || 'Source', url };
  if (name) return { kind: 'text', text: name };
  return { kind: 'none' };
}

/**
 * Step an index by `delta` (typically -1 or +1) over a list of
 * `length`, wrapping past either end so the list reads as a ring.
 * Returns `current` unchanged when `length` is 0 so a caller with an
 * empty list is a no-op.
 *
 * The photo lightbox uses this for both its prev/next arrows and the
 * Left/Right arrow keys: stepping back from the first photo lands on
 * the last, and forward from the last lands on the first. The double
 * modulo keeps the result in range for any `delta`, including the
 * negative remainder JS `%` would otherwise produce.
 */
export function wrapIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return current;
  return (((current + delta) % length) + length) % length;
}

/**
 * Classify a one-finger drag across the photo lightbox into a paging
 * step: -1 for the previous photo, +1 for the next, 0 when the drag
 * was too short or too vertical to count.
 *
 * The horizontal travel must clear `threshold` px AND exceed the
 * vertical travel, so a mostly-vertical drag (scrolling a long
 * caption, or a sloppy tap that drifts down) does not flip the photo.
 * A swipe to the LEFT (endX < startX) advances to the NEXT photo,
 * matching the platform convention where the content tracks the
 * finger.
 *
 * Multi-touch is the caller's concern, not ours - a pinch-zoom is
 * filtered out before we ever see start/end coordinates, so this stays
 * a pure single-vector classifier.
 */
export function swipeNavStep(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  threshold = 50
): -1 | 0 | 1 {
  const dx = endX - startX;
  const dy = endY - startY;
  if (Math.abs(dx) < threshold) return 0;
  if (Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}
