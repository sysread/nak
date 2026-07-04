/**
 * Pure list surgery for the conversation drawer's four thread buckets
 * (drafts / Recent / Older / Archived) in src/screens/Chat.svelte.
 * Pure functions only - no runes, no Svelte imports, no DOM. The
 * screen owns the bucket $state arrays and the pagination cursors;
 * these primitives compute classifications and next-state arrays,
 * and the screen assigns the results back for reactivity.
 *
 * Ordering contract shared with the server: every bucket is sorted
 * (updated_at desc, id desc) - the same ORDER BY the pagination RPCs
 * use - so client-side inserts and merges never fight a refetch.
 *
 * Interacts with: src/lib/supabase (Thread / ThreadCursor shapes),
 * src/lib/intuition + src/lib/context-recall (the payload-freshness
 * merge mergeServerThreadList applies).
 */
import type { Thread, ThreadCursor } from '../supabase';
import { pickFresherIntuitionPayload } from '../intuition';
import { pickFresherContextRecallPayload } from '../context-recall';

/** Classify a thread into its current bucket. Drafts are a special
 *  case - their user-facing placement is always "top of Recent" but
 *  internally they live in the drafts array. `recentCutoff` is the
 *  screen's pinned ISO boundary between Recent and Older (pinned at
 *  refresh time so a thread at the cutoff doesn't ping-pong between
 *  buckets as the clock advances). */
export function bucketFor(
  t: Thread,
  recentCutoff: string
): 'draft' | 'recent' | 'older' | 'archived' {
  if (t.isDraft) return 'draft';
  if (t.archived) return 'archived';
  return t.updated_at >= recentCutoff ? 'recent' : 'older';
}

/**
 * True when a row sorts strictly ahead of the pagination cursor under
 * the shared (updated_at desc, id desc) ordering. The realtime insert
 * path uses this to keep rows the user hasn't paginated down to yet
 * from jumping into view - they load when the user scrolls.
 */
export function sortsAheadOfCursor(t: Thread, c: ThreadCursor): boolean {
  // (updated_at desc, id desc) ordering: a row "ahead of" the cursor
  // is strictly greater than the cursor under that ordering.
  if (t.updated_at > c.updated_at) return true;
  if (t.updated_at < c.updated_at) return false;
  return t.id > c.id;
}

/** Insert one thread into an already-sorted-desc bucket, returning a
 *  fresh array. */
export function insertByUpdatedAtDesc(arr: readonly Thread[], t: Thread): Thread[] {
  // Keep the existing ordering (already sorted desc). Binary insert
  // would be faster in principle, but the bucket sizes are small
  // enough that a linear scan is simpler and just as quick.
  const idx = arr.findIndex((x) => t.updated_at > x.updated_at);
  if (idx === -1) return [...arr, t];
  return [...arr.slice(0, idx), t, ...arr.slice(idx)];
}

/** Merge two already-sorted-desc thread lists into one fresh array,
 *  deduping by id (first occurrence wins). Used by the paginated
 *  fetches and the scroll-to-search-result path, which window-fetch a
 *  range of threads and need to splice them into the loaded list
 *  without upsetting ordering. */
export function mergeByUpdatedAtDesc(
  a: readonly Thread[],
  b: readonly Thread[]
): Thread[] {
  const out: Thread[] = [];
  const seen = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (seen.has(a[i].id)) {
      i++;
      continue;
    }
    if (seen.has(b[j].id)) {
      j++;
      continue;
    }
    if (a[i].updated_at >= b[j].updated_at) {
      out.push(a[i]);
      seen.add(a[i].id);
      i++;
    } else {
      out.push(b[j]);
      seen.add(b[j].id);
      j++;
    }
  }
  for (; i < a.length; i++) if (!seen.has(a[i].id)) { out.push(a[i]); seen.add(a[i].id); }
  for (; j < b.length; j++) if (!seen.has(b[j].id)) { out.push(b[j]); seen.add(b[j].id); }
  return out;
}

/**
 * Replace a server-fetched thread list while preserving each row's
 * fresher in-memory `intuition_payload`. Used by `refreshThreads`
 * when the server snapshot may not have caught up with a recent
 * patchThread / pipeline write yet - same hazard rebucketThread
 * defends against, applied across every row of a list refresh.
 * `loaded` is the screen's currently-loaded thread set (all buckets,
 * drafts included); threads not present in it pass through unchanged.
 */
export function mergeServerThreadList(
  rows: readonly Thread[],
  loaded: readonly Thread[]
): Thread[] {
  return rows.map((row) => {
    const existing = loaded.find((t) => t.id === row.id);
    if (!existing) return row;
    return {
      ...row,
      intuition_payload: pickFresherIntuitionPayload(
        existing.intuition_payload,
        row.intuition_payload
      ),
      // Same race / same merge as intuition_payload above. The
      // two subconscious-priming caches ride parallel paths and
      // each one can land in memory ahead of a server snapshot.
      context_recall_payload: pickFresherContextRecallPayload(
        existing.context_recall_payload,
        row.context_recall_payload
      ),
    };
  });
}
