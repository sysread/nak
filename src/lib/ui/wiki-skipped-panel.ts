/**
 * UI-behavior primitives for the inline "Skipped by the wiki
 * agent" panel. Pure functions only - no runes, no Svelte
 * imports, no DOM. The companion
 * `src/components/WikiSkippedPanel.svelte` composes these with
 * its own framework-native reactivity (the row-list rune, the
 * `onWikiChange` subscription, the async load orchestration,
 * and the markup).
 */

/**
 * Compact locale-aware timestamp for the skipped-row stamp.
 *
 * The body is identical to `wiki-changelog-panel.ts`'s
 * `formatChangelogStamp` by design - the two panels sit side
 * by side as Wiki-tab sub-views and the user expects their
 * stamps to read identically. Duplicating the implementation
 * keeps each primitives module feature-scoped to its
 * component; a shared "wiki stamps" helper module would be a
 * premature abstraction for three lines.
 *
 * Falls back to the raw ISO string on parse failure rather
 * than rendering "Invalid Date".
 */
export function formatSkipTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Fallback for the thread title in the row link. Threads can
 * land in the skipped list before the auto-title worker has
 * produced anything (the wiki worker runs a day after the
 * settled message, but auto-title runs immediately - so this
 * is rare in practice). The bracketed sentinel keeps the link
 * scannable and obvious to the reader.
 */
export function displayTitle(title: string | null): string {
  return title ?? '[untitled conversation]';
}
