/**
 * Reactive store for the Samskara diagnostics tab's Corpus panel.
 * `SamskaraBrowseList.svelte` (sidebar) and `Samskaras.svelte` (detail)
 * both bind `samskaraBrowseStore`, so a search keystroke or a
 * sort/tier/hide-similar change in the controls reflows the list and the
 * detail panel together.
 *
 * Read-only: this store never writes samskara state. It mirrors the
 * memories/wiki browse stores in shape (offset browse + capped search +
 * infinite scroll) but adds a "hide similar" mode that swaps pagination
 * for a load-all + server-side cluster pass, because clustering needs
 * the whole set and the corpus is small enough to load at once.
 */
import type {
  SamskaraBrowseSort,
  SamskaraCorpusRow,
  SupabaseService,
} from './supabase';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';
import { CORPUS_LIST_LIMIT, DEFAULT_HIDE_SIMILAR_THRESHOLD } from './ui/samskara-browse';

interface SamskaraBrowseStore {
  /**
   * The samskaras currently shown. Three regimes feed this:
   *   - browse (empty query, slider off): offset window from
   *     listSamskarasPage, grown by the sentinel via loadMoreSamskaras.
   *   - search (non-empty query): capped relevance set, hasMore false.
   *   - hide-similar (slider on): the whole corpus loaded at once so the
   *     cluster collapse is global; hasMore false.
   */
  results: SamskaraCorpusRow[];
  /** Cluster assignments for the hide-similar collapse; empty when the slider is off. */
  clusterMap: Map<string, { seq: number; size: number }>;
  query: string;
  tier: number | null;
  sort: SamskaraBrowseSort;
  hideSimilar: boolean;
  hideSimilarThreshold: number;
  /** Rows paged in so far - the next browse page's offset. */
  offset: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  error: string | null;
}

export const samskaraBrowseStore = $state<SamskaraBrowseStore>({
  results: [],
  clusterMap: new Map(),
  query: '',
  tier: null,
  sort: 'recent',
  hideSimilar: false,
  hideSimilarThreshold: DEFAULT_HIDE_SIMILAR_THRESHOLD,
  offset: 0,
  hasMore: false,
  loading: false,
  loadingMore: false,
  loaded: false,
  error: null,
});

/** Which sub-view of the Samskara tab is showing. */
export type SamskaraSubView = 'corpus' | 'health' | 'summary';

/**
 * Shared sub-view selection for the Samskara tab. Lifted out of the
 * screen so the mood pill can deep-link straight to the Summary sub-view
 * (where the mood legend explains the emoji the user just clicked)
 * before navigating to the tab.
 */
export const samskaraView = $state<{ sub: SamskaraSubView }>({ sub: 'corpus' });

// Cancel an in-flight semantic search when the user keeps typing.
let currentAbort: AbortController | null = null;

/**
 * Semantic corpus search: embed the query, run the cosine RPC and an
 * ILIKE substring probe in parallel, merge vector-first with dedup. On
 * embed failure, fall back to the substring probe so the user still gets
 * matches rather than a hard error - same posture as memory search.
 */
async function searchSamskaras(
  supabase: SupabaseService,
  query: string,
  tier: number | null,
  signal: AbortSignal
): Promise<SamskaraCorpusRow[]> {
  let rawEmbedding: number[] | undefined;
  try {
    const resp = await supabase.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: query,
      signal,
    });
    rawEmbedding = resp.data[0]?.embedding;
  } catch {
    return supabase.searchSamskarasByText(query, CORPUS_LIST_LIMIT, tier);
  }
  if (!rawEmbedding || rawEmbedding.length === 0) {
    return supabase.searchSamskarasByText(query, CORPUS_LIST_LIMIT, tier);
  }
  const queryEmbedding = padEmbeddingForStorage(rawEmbedding);
  const [vectorHits, textHits] = await Promise.all([
    supabase.searchSamskarasByEmbedding(queryEmbedding, CORPUS_LIST_LIMIT, tier),
    supabase.searchSamskarasByText(query, CORPUS_LIST_LIMIT, tier),
  ]);
  const seen = new Set<string>();
  const merged: SamskaraCorpusRow[] = [];
  for (const row of [...vectorHits, ...textHits]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
    if (merged.length >= CORPUS_LIST_LIMIT) break;
  }
  return merged;
}

/**
 * (Re)load the Corpus list from the current {query, tier, sort,
 * hideSimilar} state. The single entry point the controls call; it
 * dispatches across the three regimes and, when hide-similar is on,
 * fetches the cluster map for the collapse. Callers debounce the query
 * path; this runs immediately. Cancels any in-flight search so a stale
 * result can't clobber the latest view.
 */
export async function refreshSamskaraView(supabase: SupabaseService): Promise<void> {
  if (currentAbort) currentAbort.abort();
  const trimmed = samskaraBrowseStore.query.trim();
  samskaraBrowseStore.loading = true;
  samskaraBrowseStore.error = null;

  try {
    if (trimmed.length > 0) {
      // Search regime: capped relevance set, no pagination.
      const ctl = new AbortController();
      currentAbort = ctl;
      const hits = await searchSamskaras(supabase, trimmed, samskaraBrowseStore.tier, ctl.signal);
      if (ctl.signal.aborted) return;
      samskaraBrowseStore.results = hits;
      samskaraBrowseStore.offset = hits.length;
      samskaraBrowseStore.hasMore = false;
    } else if (samskaraBrowseStore.hideSimilar) {
      // Hide-similar regime: load the whole (small) corpus so the
      // cluster collapse is global, no pagination. CORPUS_LIST_LIMIT * 20
      // is comfortably above the dedup target ceiling.
      const page = await supabase.listSamskarasPage({
        offset: 0,
        pageSize: CORPUS_LIST_LIMIT * 20,
        tier: samskaraBrowseStore.tier,
        sort: samskaraBrowseStore.sort,
      });
      samskaraBrowseStore.results = page.rows;
      samskaraBrowseStore.offset = page.rows.length;
      samskaraBrowseStore.hasMore = false;
    } else {
      // Browse regime: first offset page, pagination on.
      const page = await supabase.listSamskarasPage({
        offset: 0,
        pageSize: CORPUS_LIST_LIMIT,
        tier: samskaraBrowseStore.tier,
        sort: samskaraBrowseStore.sort,
      });
      samskaraBrowseStore.results = page.rows;
      samskaraBrowseStore.offset = page.rows.length;
      samskaraBrowseStore.hasMore = page.hasMore;
    }

    // Cluster map only matters for the collapse; fetch it when the
    // slider is on, clear it otherwise. A cluster failure leaves the
    // list intact (the collapse degrades to no-collapse).
    if (samskaraBrowseStore.hideSimilar) {
      try {
        samskaraBrowseStore.clusterMap = await supabase.samskaraClusterCorpus(
          samskaraBrowseStore.hideSimilarThreshold,
          samskaraBrowseStore.tier
        );
      } catch {
        samskaraBrowseStore.clusterMap = new Map();
      }
    } else {
      samskaraBrowseStore.clusterMap = new Map();
    }
  } catch (err) {
    if (currentAbort?.signal.aborted) return;
    samskaraBrowseStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (!currentAbort?.signal.aborted) {
      samskaraBrowseStore.loading = false;
      samskaraBrowseStore.loaded = true;
    }
    currentAbort = null;
  }
}

/**
 * Append the next browse page. No-op unless in the plain browse regime
 * (empty query, slider off, more to load), so the sentinel can fire
 * freely. A failed page leaves hasMore intact so the next scroll
 * retries.
 */
export async function loadMoreSamskaras(supabase: SupabaseService): Promise<void> {
  if (samskaraBrowseStore.loadingMore || !samskaraBrowseStore.hasMore) return;
  if (samskaraBrowseStore.query.trim().length > 0 || samskaraBrowseStore.hideSimilar) return;
  samskaraBrowseStore.loadingMore = true;
  try {
    const page = await supabase.listSamskarasPage({
      offset: samskaraBrowseStore.offset,
      pageSize: CORPUS_LIST_LIMIT,
      tier: samskaraBrowseStore.tier,
      sort: samskaraBrowseStore.sort,
    });
    samskaraBrowseStore.results = [...samskaraBrowseStore.results, ...page.rows];
    samskaraBrowseStore.offset += page.rows.length;
    samskaraBrowseStore.hasMore = page.hasMore;
    samskaraBrowseStore.error = null;
  } catch (err) {
    samskaraBrowseStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    samskaraBrowseStore.loadingMore = false;
  }
}
