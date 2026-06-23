/**
 * Reactive store backing the Artifacts drawer tab - the user's live
 * attachments across every conversation, for review and manual deletion.
 *
 * Unlike `documents-store`, there is no semantic search: the listing is a
 * single paged query (`SupabaseService.listArtifacts`) with a filename
 * substring filter, a kind filter (all / images / files), and a sort
 * (newest / largest). Browse and "search" are the same path - changing any
 * filter just reloads the first page. A monotonic load token guards against
 * a slow earlier request clobbering a newer one after rapid filter changes.
 */
import type { SupabaseService, ArtifactListRow } from './supabase';

export type ArtifactKind = 'all' | 'image' | 'file';
export type ArtifactSort = 'newest' | 'largest';

/** Rows per page; the infinite-scroll sentinel grows the window. */
export const ARTIFACTS_PAGE_SIZE = 30;

interface ArtifactStore {
  results: ArtifactListRow[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  query: string;
  kind: ArtifactKind;
  sort: ArtifactSort;
  offset: number;
  hasMore: boolean;
  loadingMore: boolean;
}

export const artifactStore = $state<ArtifactStore>({
  results: [],
  loading: false,
  loaded: false,
  error: null,
  query: '',
  kind: 'all',
  sort: 'newest',
  offset: 0,
  hasMore: false,
  loadingMore: false,
});

// Bumped on every first-page load; a resolved request whose token is stale
// (a newer load started meanwhile) drops its result instead of clobbering.
let loadToken = 0;

/**
 * Load the first page from the current query/kind/sort. Call after any
 * filter change (debounce the query keystrokes upstream).
 */
export async function loadArtifactsFirstPage(supabase: SupabaseService): Promise<void> {
  const token = ++loadToken;
  artifactStore.loading = true;
  artifactStore.error = null;
  try {
    const page = await supabase.listArtifacts({
      offset: 0,
      pageSize: ARTIFACTS_PAGE_SIZE,
      query: artifactStore.query,
      kind: artifactStore.kind,
      sort: artifactStore.sort,
    });
    if (token !== loadToken) return; // superseded by a newer load
    artifactStore.results = page.rows;
    artifactStore.offset = page.rows.length;
    artifactStore.hasMore = page.hasMore;
  } catch (err) {
    if (token !== loadToken) return;
    artifactStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (token === loadToken) {
      artifactStore.loading = false;
      artifactStore.loaded = true;
    }
  }
}

/** Append the next page (infinite-scroll sentinel). No-op while one is in flight. */
export async function loadMoreArtifacts(supabase: SupabaseService): Promise<void> {
  if (artifactStore.loadingMore || !artifactStore.hasMore) return;
  artifactStore.loadingMore = true;
  try {
    const page = await supabase.listArtifacts({
      offset: artifactStore.offset,
      pageSize: ARTIFACTS_PAGE_SIZE,
      query: artifactStore.query,
      kind: artifactStore.kind,
      sort: artifactStore.sort,
    });
    artifactStore.results = [...artifactStore.results, ...page.rows];
    artifactStore.offset += page.rows.length;
    artifactStore.hasMore = page.hasMore;
    artifactStore.error = null;
  } catch (err) {
    artifactStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    artifactStore.loadingMore = false;
  }
}

/** Drop one row after a successful delete, without re-querying. */
export function removeArtifactRow(id: string): void {
  artifactStore.results = artifactStore.results.filter((r) => r.id !== id);
}
