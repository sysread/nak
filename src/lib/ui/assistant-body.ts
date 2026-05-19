/**
 * UI-behavior primitives for the assistant-message body.
 * Pure functions only - no runes, no Svelte imports, no DOM.
 * The companion `src/components/AssistantBody.svelte` composes
 * these with its own framework-native reactivity (the
 * `citationsOpen` rune, the `flashCite` rune for the body-click
 * delegation, the markup, and the click handler that intercepts
 * the markdown's `^N^` citation refs).
 *
 * Citation-ref detection has to mirror the regex used by the
 * markdown extension in `src/lib/markdown.ts`; the pattern is
 * duplicated here on purpose so this module stays
 * decision-only (a unit test catches drift between the two
 * sides).
 */

/**
 * Pattern for the inline citation superscripts the markdown
 * extension emits. Matches `^N^` and `^i,j,k^` shapes (one or
 * more comma-separated indices). Kept private to the module -
 * `hasCitationRefsInBody` is the only consumer.
 */
const CITATION_REF_PATTERN = /\^\d+(?:\s*,\s*\d+)*\^/;

/**
 * Whether the assistant body carries `^N^` / `^i,j^` superscript
 * references. Used to detect the "older row" case: a turn from
 * before we persisted the citations column still has the inline
 * marks but no source list to expand behind them. In that case
 * the panel still surfaces - with an "unavailable" notice - so a
 * click on `^2^` does not silently no-op.
 */
export function hasCitationRefsInBody(content: string): boolean {
  if (!content) return false;
  return CITATION_REF_PATTERN.test(content);
}

/**
 * Orphan-refs predicate. True only when the body has inline
 * marks but no stored citation list - the user-visible "sources
 * weren't saved on this message" state. A turn with neither
 * refs nor stored citations (the common case) is NOT orphaned
 * and should surface no toggle; this flag is the gate that
 * picks the unavailable surface over the silent path.
 */
export function isCitationsUnavailable(
  hasRefs: boolean,
  hasCitations: boolean
): boolean {
  return hasRefs && !hasCitations;
}

/**
 * Whether the citations toggle button should render at all.
 * True when there is something to surface - either a real
 * citation list to toggle, or the unavailable notice to expose.
 * The common case (no refs, no citations) returns false and the
 * action bar omits the button entirely.
 */
export function showCitationsControls(
  hasCitations: boolean,
  citationsUnavailable: boolean
): boolean {
  return hasCitations || citationsUnavailable;
}

/**
 * Delay before flashing the matching citation row when the user
 * clicks a `^N^` superscript. Zero when the panel was already
 * open (no slide to wait for); 240ms otherwise to cover the
 * 220ms slide-down transition plus a cushion for layout to
 * settle. Flashing earlier reads as jank - the highlight starts
 * while the row is still sliding in.
 */
export function citationFlashDelay(wasOpen: boolean): number {
  return wasOpen ? 0 : 240;
}

/**
 * Parse the citation index out of a markdown-emitted href like
 * `#cite-3`. Returns null for malformed inputs so the caller
 * can early-return without flashing. The regex is the inverse
 * of what `src/lib/markdown.ts` emits.
 */
export function parseCitationRefHref(href: string): number | null {
  const m = /^#cite-(\d+)$/.exec(href);
  if (!m) return null;
  const idx = Number(m[1]);
  if (!Number.isFinite(idx)) return null;
  return idx;
}
