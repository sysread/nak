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
import type { RecipeTocEntry } from '../cooklang';

/**
 * Total number of jump targets in a recipe's table of contents: each
 * top-level entry (Ingredients / Instructions) plus each of its section
 * sub-entries. Internal to the `recipeTocVisible` policy below.
 */
function recipeTocTargetCount(toc: RecipeTocEntry[]): number {
  return toc.reduce((total, entry) => total + 1 + entry.sections.length, 0);
}

/**
 * Whether the detail pane's table of contents is worth showing -
 * below two jump targets it's a single link with nothing to jump
 * past, which is clutter rather than navigation. Kept out of the
 * cooklang renderer because it's a presentation threshold, not part
 * of the document structure.
 */
export function recipeTocVisible(toc: RecipeTocEntry[]): boolean {
  return recipeTocTargetCount(toc) >= 2;
}

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

/**
 * Accessible label for a thumbnail in the detail pane's photo strip.
 * Position and total give a screen-reader user the same "3 of 5"
 * orientation the lightbox counter gives sighted users; the caption
 * rides along when the photo has one. `index` is 0-based (the render
 * loop's counter); the label speaks 1-based.
 */
export function photoOpenAriaLabel(
  index: number,
  total: number,
  label: string | null,
): string {
  const base = `Open photo ${index + 1} of ${total}`;
  return label ? `${base}: ${label}` : base;
}

/**
 * Phases of the lightbox photo carousel, which renders a 3-slide track
 * - [prev | current | next] - and slides it horizontally:
 *
 *   - `idle`   - resting on the middle slide, no animation. Also the
 *                landing phase after a commit: the slid-to photo now
 *                occupies the middle slot, so snapping the track back
 *                to center here is invisible.
 *   - `drag`   - tracking a finger mid-swipe; the track follows by
 *                `dragDx` px with no transition.
 *   - `to-next`/`to-prev` - committing a swipe (or an arrow / key
 *                press): animate the track one slide left or right.
 *   - `cancel` - a swipe that fell short of the threshold; ease the
 *                track back to center.
 */
export type LightboxSlidePhase = 'idle' | 'drag' | 'to-next' | 'to-prev' | 'cancel';

/**
 * True while a commit animation is mid-flight; the lightbox ignores
 * new gestures and key presses until the slide settles so they can't
 * strand the track between slides. `cancel` counts as a commit here -
 * an ease-back-to-center is still an animation a fresh gesture would
 * tear mid-frame.
 */
export function isCommitAnimating(phase: LightboxSlidePhase): boolean {
  return phase === 'to-next' || phase === 'to-prev' || phase === 'cancel';
}

/**
 * Duration of the lightbox slide animation. Shared by the CSS
 * transition baked into `lightboxTrackStyle` and the commit timer in
 * `Cookbook.svelte` that swaps the photo index once the slide settles.
 * The two MUST agree: if the timer fired before the transition
 * finished, the track would visibly jump mid-slide. The component adds
 * a small buffer on top so it always waits for the transition to end.
 */
export const LIGHTBOX_SLIDE_MS = 250;

/**
 * Inline `style` for the carousel track in a given phase. The track is
 * a flex row of three viewport-width slides; its own width is one
 * viewport, so `translateX(-100%)` centers the middle slide,
 * `translateX(0%)` reveals the prev slide, and `translateX(-200%)`
 * reveals the next.
 *
 * Only `drag` mixes in pixels (`-100%` plus the live finger offset);
 * the animated phases use whole-slide percentages so the transition
 * lands exactly on a slide boundary regardless of how far the drag
 * traveled. `idle` and `drag` carry `transition: none` so the resting
 * snap-back and the finger-follow never animate; the rest carry the
 * shared-duration transition.
 */
export function lightboxTrackStyle(phase: LightboxSlidePhase, dragDx: number): string {
  const ease = `transform ${LIGHTBOX_SLIDE_MS}ms ease-out`;
  switch (phase) {
    case 'drag':
      return `transform: translateX(calc(-100% + ${dragDx}px)); transition: none;`;
    case 'to-next':
      return `transform: translateX(-200%); transition: ${ease};`;
    case 'to-prev':
      return `transform: translateX(0%); transition: ${ease};`;
    case 'cancel':
      return `transform: translateX(-100%); transition: ${ease};`;
    case 'idle':
    default:
      return 'transform: translateX(-100%); transition: none;';
  }
}
