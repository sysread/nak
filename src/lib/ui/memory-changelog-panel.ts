/**
 * UI-behavior primitives for the inline memory-changelog panel.
 * Pure functions only - no runes, no Svelte imports, no DOM.
 * The companion `src/components/MemoryChangelogPanel.svelte` composes
 * these with its own framework-native reactivity (the page-list rune,
 * the pagination, the `onMemoryChange` subscription, the async fetch
 * orchestration, and the markup).
 *
 * Parallel to `src/lib/ui/wiki-changelog-panel.ts`; a port to another
 * framework would consume `MemoryChangelogEntry` identically.
 */
import type { MemoryChangelogEntry } from '../supabase';

/**
 * Page size for the changelog fetch. 50 reads as "a useful screenful"
 * without dragging the first paint. The (user_id, created_at desc)
 * index makes the range scan cheap, but more rows per request means
 * more layout work the moment the panel mounts.
 */
export const PAGE_SIZE = 50;

/**
 * Display label for a changelog kind. Maps the database verbs
 * (`create` / `update` / `delete`) to the user-facing past tenses the
 * chip carries (`Added` / `Edited` / `Deleted`). Librarian
 * consolidations are stored as `update`, so they read as `Edited` -
 * the message ("Merged ... into this memory.") carries the merge
 * detail.
 */
export function kindLabel(kind: MemoryChangelogEntry['kind']): string {
  if (kind === 'create') return 'Added';
  if (kind === 'update') return 'Edited';
  return 'Deleted';
}

/**
 * Compact locale-aware timestamp. Matches the format the wiki
 * changelog uses so the two changelog-style surfaces read the same.
 * Falls back to the raw ISO string on parse failure rather than
 * rendering an "Invalid Date".
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
 * Below this many characters of change, the delta is noise - a reworded
 * sentence, a fixed typo - and rendering it on every row would bury the
 * edits that actually moved a memory's size. Roughly a long sentence.
 */
const SIZE_DELTA_FLOOR_CHARS = 120;

export interface MemorySizeDelta {
  /** Signed change, for the caller's up/down styling. */
  chars: number;
  /** Rendered chip text, e.g. "+412" / "-1,203". */
  label: string;
  /** True once the change is large enough to deserve visual emphasis. */
  significant: boolean;
}

/**
 * The size-delta chip for a changelog row, or null when there is
 * nothing worth showing.
 *
 * Null in three distinct cases, all of which should render no chip:
 *   - either size is null (a row from before the columns existed; the
 *     historical size is unrecoverable, so we say nothing rather than
 *     implying a zero-length body)
 *   - the delta is zero (a label-only edit)
 *   - the delta is under the noise floor
 *
 * Memory bodies are replayed verbatim into every recall prompt, so this
 * is the surface that answers "did that consolidation actually condense
 * anything, or just concatenate?" - see docs/dev/memory.md.
 */
export function memorySizeDelta(
  entry: Pick<MemoryChangelogEntry, 'chars_before' | 'chars_after'>
): MemorySizeDelta | null {
  const { chars_before: before, chars_after: after } = entry;
  if (before === null || after === null) return null;
  const chars = after - before;
  if (Math.abs(chars) < SIZE_DELTA_FLOOR_CHARS) return null;
  const sign = chars > 0 ? '+' : '-';
  return {
    chars,
    label: `${sign}${Math.abs(chars).toLocaleString()}`,
    // A create's whole body counts as growth but is not a regression,
    // so emphasis keys off magnitude only; the caller styles direction.
    significant: Math.abs(chars) >= SIZE_DELTA_FLOOR_CHARS * 4,
  };
}

/**
 * Whether the row's label should render as a clickable link to the
 * underlying memory. False when the memory was deleted
 * (`kind === 'delete'`) or when the FK was cleared by the
 * on-delete-set-null trigger. The delete-kind guard is belt-and-braces
 * - the FK clear should have fired - but the second check costs nothing
 * and prevents a link to a row that may already be gone in some race.
 */
export function canOpenMemory(entry: MemoryChangelogEntry): boolean {
  return entry.memory_id !== null && entry.kind !== 'delete';
}

/**
 * Whether the most recent fetch returned fewer rows than asked for -
 * which means the cursor reached the tail and "Load more" has nothing
 * to ask for.
 */
export function isExhausted(
  rowsReturned: number,
  pageSize: number = PAGE_SIZE
): boolean {
  return rowsReturned < pageSize;
}
