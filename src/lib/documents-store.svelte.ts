/**
 * Reactive store shared by the Library drawer tab. Sidebar
 * (`LibraryList.svelte`) and main panel (`Library.svelte`) both bind against
 * `documentStore`, so a search keystroke in the sidebar filters the listing
 * and a panel-side mutation (upload / edit / delete) updates the drawer
 * without a refetch.
 *
 * Parallel to `wiki-store.svelte.ts`, with two differences:
 *   - Browse order is newest-first (created_at desc), not alphabetical.
 *   - Search is passage-level: searchDocumentsSemantic returns chunk hits,
 *     which we dedupe to unique documents in relevance order and resolve back
 *     to full rows via getDocumentsByIds. `snippets` carries the best-matching
 *     passage per document so the list can show why a doc matched.
 */
import {
  DEFAULT_LIST_PAGE_SIZE,
  type Document,
  type SupabaseService,
} from './supabase';
import type { VeniceClient } from './venice';
import { searchDocumentsSemantic } from './documents';

interface DocumentStore {
  /**
   * The documents currently shown. Browse (empty query) is an offset window
   * paged newest-first by `listDocumentsPage`, grown by the sidebar's
   * infinite-scroll sentinel. Search (non-empty query) is a capped, unpaged
   * relevance set; `hasMore` is forced false there.
   */
  results: Document[];
  /** Best-matching passage per document id, populated during a search so the
   * list can show the snippet that matched. Empty in browse mode. */
  snippets: Record<string, string>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  query: string;
  offset: number;
  hasMore: boolean;
  loadingMore: boolean;
}

export const documentStore = $state<DocumentStore>({
  results: [],
  snippets: {},
  loading: false,
  loaded: false,
  error: null,
  query: '',
  offset: 0,
  hasMore: false,
  loadingMore: false,
});

// Match the assistant's doc_search reach so a drawer search never hides a
// document the assistant can find passages in.
const DOCUMENT_SEARCH_CHUNK_LIMIT = 60;

let currentAbort: AbortController | null = null;

export async function loadDocumentsFirstPage(supabase: SupabaseService): Promise<void> {
  if (currentAbort) currentAbort.abort();
  documentStore.loading = true;
  documentStore.error = null;
  documentStore.snippets = {};
  try {
    const page = await supabase.listDocumentsPage({
      offset: 0,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
    documentStore.results = page.rows;
    documentStore.offset = page.rows.length;
    documentStore.hasMore = page.hasMore;
  } catch (err) {
    documentStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    documentStore.loading = false;
    documentStore.loaded = true;
  }
}

export async function loadMoreDocuments(supabase: SupabaseService): Promise<void> {
  if (documentStore.loadingMore || !documentStore.hasMore) return;
  if (documentStore.query.trim().length > 0) return;
  documentStore.loadingMore = true;
  try {
    const page = await supabase.listDocumentsPage({
      offset: documentStore.offset,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
    documentStore.results = [...documentStore.results, ...page.rows];
    documentStore.offset += page.rows.length;
    documentStore.hasMore = page.hasMore;
    documentStore.error = null;
  } catch (err) {
    documentStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    documentStore.loadingMore = false;
  }
}

/**
 * Drive `documentStore` from the bound query. Empty query -> the newest-first
 * browse list; non-empty -> the passage search, deduped to documents in
 * relevance order. Callers should debounce - this runs immediately. Cancels
 * any in-flight search so a stale result can't clobber the latest query.
 */
export async function runDocumentSearch(
  supabase: SupabaseService,
  venice: VeniceClient | null
): Promise<void> {
  if (documentStore.query.trim().length === 0) {
    return loadDocumentsFirstPage(supabase);
  }
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  documentStore.loading = true;
  documentStore.error = null;
  try {
    const hits = await searchDocumentsSemantic(
      documentStore.query.trim(),
      DOCUMENT_SEARCH_CHUNK_LIMIT,
      { supabase, venice, signal: ctl.signal }
    );
    if (ctl.signal.aborted) return;

    // Dedupe chunk hits to unique documents, preserving relevance order, and
    // keep the first (best) passage per document as the snippet.
    const orderedIds: string[] = [];
    const snippets: Record<string, string> = {};
    for (const hit of hits) {
      if (!(hit.document_id in snippets)) {
        orderedIds.push(hit.document_id);
        snippets[hit.document_id] = hit.content;
      }
    }
    const docs = await supabase.getDocumentsByIds(orderedIds);
    if (ctl.signal.aborted) return;
    documentStore.results = docs;
    documentStore.snippets = snippets;
    documentStore.offset = docs.length;
    documentStore.hasMore = false;
  } catch (err) {
    if (ctl.signal.aborted) return;
    documentStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (currentAbort === ctl) currentAbort = null;
    if (!ctl.signal.aborted) {
      documentStore.loading = false;
      documentStore.loaded = true;
    }
  }
}

/** Replace one row in `results` without re-querying (after an edit). */
export function patchDocumentRow(id: string, patch: Partial<Document>): void {
  documentStore.results = documentStore.results.map((d) =>
    d.id === id ? { ...d, ...patch } : d
  );
}

/** Drop one row from the list (after a delete). */
export function removeDocumentRow(id: string): void {
  documentStore.results = documentStore.results.filter((d) => d.id !== id);
}

/** Prepend a freshly-uploaded document (browse order is newest-first). */
export function addDocumentRow(row: Document): void {
  documentStore.results = [row, ...documentStore.results.filter((d) => d.id !== row.id)];
}
