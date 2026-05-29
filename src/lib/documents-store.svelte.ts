/**
 * Reactive store shared by the Library drawer tab. Sidebar
 * (`LibraryList.svelte`) and main panel (`Library.svelte`) both bind against
 * `documentStore`, so a search keystroke in the sidebar filters the listing
 * and a panel-side mutation (upload / edit / delete) updates the drawer
 * without a refetch.
 *
 * Parallel to `wiki-store.svelte.ts`, with two differences:
 *   - Browse order is newest-first (created_at desc), not alphabetical.
 *   - Search is a plain substring match over the user's documents
 *     (`SupabaseService.searchDocuments`) returning whole documents - there is
 *     no embedding/passage layer. The chat model's precise in-document search
 *     is doc_grep; this drawer surface is browse-by-keyword.
 */
import {
  DEFAULT_LIST_PAGE_SIZE,
  type Document,
  type SupabaseService,
} from './supabase';

interface DocumentStore {
  /**
   * The documents currently shown. Browse (empty query) is an offset window
   * paged newest-first by `listDocumentsPage`, grown by the sidebar's
   * infinite-scroll sentinel. Search (non-empty query) is a capped, unpaged
   * match set; `hasMore` is forced false there.
   */
  results: Document[];
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
  loading: false,
  loaded: false,
  error: null,
  query: '',
  offset: 0,
  hasMore: false,
  loadingMore: false,
});

// Cap on the drawer's keyword-search result set.
const DOCUMENT_SEARCH_LIMIT = 100;

let currentAbort: AbortController | null = null;

// Internal: the empty-query browse load. Reached via runDocumentSearch, which
// routes an empty query here. Not exported - the drawer and tab-pick paths all
// go through runDocumentSearch.
async function loadDocumentsFirstPage(supabase: SupabaseService): Promise<void> {
  if (currentAbort) currentAbort.abort();
  documentStore.loading = true;
  documentStore.error = null;
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
 * browse list; non-empty -> a substring match over the user's documents.
 * Callers should debounce - this runs immediately. Cancels any in-flight load
 * so a stale result can't clobber the latest query.
 */
export async function runDocumentSearch(supabase: SupabaseService): Promise<void> {
  if (documentStore.query.trim().length === 0) {
    return loadDocumentsFirstPage(supabase);
  }
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  documentStore.loading = true;
  documentStore.error = null;
  try {
    const docs = await supabase.searchDocuments({
      query: documentStore.query.trim(),
      limit: DOCUMENT_SEARCH_LIMIT,
    });
    if (ctl.signal.aborted) return;
    documentStore.results = docs;
    documentStore.offset = docs.length;
    // Search results are capped, not paged - close the sentinel.
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
