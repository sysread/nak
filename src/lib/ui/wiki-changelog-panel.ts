/**
 * UI-behavior primitives for the inline wiki-changelog panel.
 * Pure functions only - no runes, no Svelte imports, no DOM.
 * The companion `src/components/WikiChangelogPanel.svelte`
 * composes these with its own framework-native reactivity (the
 * page-list rune, the pagination `$effect`, the `onWikiChange`
 * subscription, the async fetch orchestration, and the markup).
 *
 * Type imports from `$lib/supabase` carry the row shape; a port
 * to another framework would consume `WikiChangelogEntry`
 * identically.
 */
import type { WikiChangelogEntry } from '../supabase';

/**
 * Page size for the changelog fetch. 50 reads as "a useful
 * screenful" without dragging the first paint. Bumping it costs
 * little - the index makes the range scan cheap - but more rows
 * per request means more layout work the moment the panel mounts.
 */
export const PAGE_SIZE = 50;

/**
 * Display label for a changelog kind. Maps the database verbs to the
 * user-facing past tenses the chip carries. The record_* kinds (writes
 * to an article's dated records, which reuse this changelog) carry a
 * "record" qualifier so the chip distinguishes "added a record to X"
 * from "added article X".
 */
export function kindLabel(kind: WikiChangelogEntry['kind']): string {
  switch (kind) {
    case 'create':
      return 'Added';
    case 'update':
      return 'Edited';
    case 'delete':
      return 'Deleted';
    case 'record_create':
      return 'Added record';
    case 'record_update':
      return 'Edited record';
    case 'record_delete':
      return 'Removed record';
  }
}

/**
 * Compact locale-aware timestamp. Matches the format Cookbook's
 * version-history rows use so the two changelog-style surfaces
 * read the same. Falls back to the raw ISO string on parse
 * failure rather than rendering an "Invalid Date".
 */
export function formatChangelogStamp(iso: string): string {
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
 * Whether the row's title should render as a clickable link to
 * the underlying article. False only when the ARTICLE itself was
 * deleted (`kind === 'delete'`) or when the FK was cleared by the
 * on-delete-set-null trigger. Note `kind !== 'delete'` deliberately
 * still opens for `record_delete`: removing a record leaves the
 * parent article intact, so that row links through to the surviving
 * article. The delete-kind guard is belt-and-braces - the FK clear
 * should have fired - but the second check costs nothing and prevents
 * a link to a row that may already be gone in some race.
 */
export function canOpenArticle(entry: WikiChangelogEntry): boolean {
  return entry.article_id !== null && entry.kind !== 'delete';
}

/**
 * Whether the most recent fetch returned fewer rows than asked
 * for - which means the cursor reached the tail and "Load more"
 * has nothing to ask for. Pairs with the Supabase RPC contract
 * (fixed page size requested, returns up-to-N).
 */
export function isExhausted(
  rowsReturned: number,
  pageSize: number = PAGE_SIZE
): boolean {
  return rowsReturned < pageSize;
}
