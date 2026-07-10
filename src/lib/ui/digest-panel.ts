/**
 * UI-behavior primitives for the Daily digest panel. Pure functions
 * only - no runes, no Svelte imports, no DOM. The companion
 * `src/components/DigestPanel.svelte` composes these with its own
 * framework-native reactivity (the page-list rune, the load-more
 * orchestration, and the markup).
 */

/**
 * Page size for the digest fetch. One row per calendar day, so 30
 * reads as "about a month per page" - a useful screenful without
 * dragging the first paint.
 */
export const PAGE_SIZE = 30;

/**
 * Long-form label for a digest's day. digest_date is a plain
 * YYYY-MM-DD in the user's timezone, so it is parsed field-by-field
 * into a LOCAL date - `new Date('2026-07-09')` would parse as UTC
 * midnight and render as the previous day for users west of
 * Greenwich. Falls back to the raw string on parse failure rather
 * than rendering an "Invalid Date".
 */
export function formatDigestDate(digestDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(digestDate);
  if (!m) return digestDate;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return digestDate;
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Header count label for one digest card. Distinguishes the
 * placeholder rows the sweep writes when a day's messages vanished
 * before the agent read them (zero threads) from real digests.
 */
export function conversationCountLabel(count: number): string {
  if (count === 0) return 'No conversations';
  if (count === 1) return '1 conversation';
  return `${count} conversations`;
}

/**
 * Whether the most recent fetch returned fewer rows than asked for -
 * the cursor reached the tail and "Load more" has nothing to ask
 * for. Same contract as the wiki/memory changelog panels.
 */
export function isExhausted(
  rowsReturned: number,
  pageSize: number = PAGE_SIZE
): boolean {
  return rowsReturned < pageSize;
}
