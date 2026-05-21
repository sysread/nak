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

/**
 * Headline for the green success strip that appears after a
 * manual retry click. The toolCalls count is a load-bearing
 * domain signal:
 *
 *   - 0  - skip cleared but the agent decided no edits were
 *          warranted. Critical to call out distinctly: silently
 *          dropping the row in this case left users wondering
 *          why "Retry" appeared to do nothing (the fix that
 *          motivated keeping the row visible until dismissed).
 *   - 1  - singular noun phrase, "1 wiki edit".
 *   - 2+ - plural noun phrase with the count.
 *
 * Negative counts are treated like zero - the agent path never
 * produces a negative count, but rendering "Retry done. -1 wiki
 * edits landed." would be the most embarrassing shape on the
 * off chance the contract changes upstream.
 */
export function retryResultHeadline(toolCalls: number): string {
  if (toolCalls <= 0) {
    return 'Retry done. The agent decided no edits were warranted.';
  }
  if (toolCalls === 1) {
    return 'Retry done. 1 wiki edit landed.';
  }
  return `Retry done. ${toolCalls} wiki edits landed.`;
}
