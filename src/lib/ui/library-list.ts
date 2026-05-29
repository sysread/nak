/**
 * UI-behavior primitives for the Library drawer listing and document panel.
 * Pure functions only - no runes, no Svelte imports, no DOM. The companion
 * `src/components/LibraryList.svelte` and `src/screens/Library.svelte` compose
 * these with their own framework-native reactivity (the debounced search
 * `$effect`, the infinite-scroll sentinel, the upload handler, the markup).
 */

/**
 * Debounce window between the user's last keystroke and the semantic-search
 * round trip. Same 200ms the wiki / recipe / memory listings use so
 * typing-burst latency feels uniform across the drawer tabs.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/** Scanner label during an in-flight request - framing differs by whether the
 * user typed a query or we're doing the initial empty-query load. */
export function scannerLabel(query: string): string {
  return query.trim().length > 0 ? 'Searching documents' : 'Loading documents';
}

/** Empty-listing message. Active query with no hits vs a cold, empty Library. */
export function emptyMessage(query: string): string {
  return query.trim().length > 0
    ? 'No matching documents.'
    : 'No documents yet. Upload a file to keep it as searchable reference material.';
}

/**
 * Human-readable byte size. Binary units (1024) to match what file managers
 * report for the same file, so a doc the OS calls "1.4 MB" reads the same here.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export type ExtractionStatus = 'pending' | 'done' | 'failed';

/**
 * Short status chip label for a document's extraction state. 'done' returns
 * empty - a successfully-indexed doc needs no badge; only the in-progress and
 * failed states are worth surfacing.
 */
export function statusLabel(status: ExtractionStatus): string {
  switch (status) {
    case 'pending':
      return 'Processing';
    case 'failed':
      return 'Not searchable';
    default:
      return '';
  }
}
