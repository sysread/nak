/**
 * Reactive store shared by the Memories drawer tab. Sidebar
 * (`MemoryList.svelte`) and main panel (`Memories.svelte`) both bind
 * against `memoriesStore`, so a search keystroke in the sidebar
 * filters the panel's list and a panel-side mutation (edit, delete,
 * relate) updates the sidebar without a refetch.
 *
 * Parallel to `cookbook-store.svelte.ts` and `wiki-store.svelte.ts`,
 * minus the change-event channel - the volitional memory tools
 * (`memory_create`, `memory_update`, etc.) already invalidate via the
 * UI-side write paths that go through this store. If a future tool
 * path lands writes server-side without going through here, we'll add
 * a memory-events channel mirroring cookbook-events.
 *
 * Search semantics mirror what the old Memories modal did inline:
 * `searchMemoriesSemantic` from `./memories.ts` so the UI list matches
 * the assistant's `memory_search` results exactly. The store owns the
 * debounce timer + AbortController so rapid typing doesn't fire one
 * embedding request per character.
 */
import type { Memory, MemoryRelation, SupabaseService, TopicVocabulary } from './supabase';
import { searchMemoriesSemantic } from './memories';

interface MemoriesStore {
  /**
   * The memory rows currently shown. Two regimes feed this list:
   *
   *   - Browse (empty query): an offset window paged in from
   *     `listMemoriesPage`, most-recent first, grown by the sidebar's
   *     infinite-scroll sentinel via `loadMoreMemories`.
   *   - Search (non-empty query): a capped, unpaged relevance set from
   *     `searchMemoriesSemantic` - the same contract the assistant's
   *     `memory_search` tool uses. `hasMore` is forced false here; you
   *     refine the query rather than paging search hits.
   */
  results: Memory[];
  /**
   * Outbound relations keyed by source memory id. Hydrated alongside
   * `results` so the panel renders edges per-card without an
   * await-per-row.
   */
  relations: Map<string, MemoryRelation[]>;
  loading: boolean;
  /** Set true after the first load resolves, success or error. */
  loaded: boolean;
  error: string | null;
  /** Bound to the sidebar search input. */
  query: string;
  /** Row count paged into `results` so far - the next browse page's offset. */
  offset: number;
  /**
   * False once the browse list is drained, or whenever a search is
   * active (search results are capped, not paged). Gates the sidebar's
   * infinite-scroll sentinel.
   */
  hasMore: boolean;
  /** True while a `loadMoreMemories` page is in flight (drives the sentinel spinner). */
  loadingMore: boolean;
  /**
   * Active topic filter. Empty array = no filter. Includes the
   * UNTAGGED_TOPIC_SENTINEL when the user selected "untagged" in the
   * dropdown. Threaded into `searchMemoriesSemantic` so the same
   * predicate applies to vector and ILIKE hits.
   */
  selectedTopics: string[];
  /**
   * Per-user topic vocabulary + per-topic counts returned by
   * `list_user_memory_topics`. Drives the TopicsFilter dropdown's
   * options and the count each row shows in parens. Refreshed on first
   * load and after a tagging realtime event lands. The "(untagged)"
   * sentinel is NOT in `topics` - the TopicsFilter component synthesises
   * that row from the `untagged` count.
   */
  topicsVocabulary: TopicVocabulary;
}

export const memoriesStore = $state<MemoriesStore>({
  results: [],
  relations: new Map(),
  loading: false,
  loaded: false,
  error: null,
  query: '',
  offset: 0,
  hasMore: false,
  loadingMore: false,
  selectedTopics: [],
  topicsVocabulary: { topics: [], untagged: 0 },
});

// Match the assistant's `memory_search` per-call cap so a search never
// hides rows the assistant can reach.
const MEMORIES_LIST_LIMIT = 100;

// Cancel the in-flight semantic search if the user keeps typing.
// Module-scoped so the debounce timer can reach it.
let currentAbort: AbortController | null = null;

/**
 * Hydrate outbound relation edges for a set of memory ids into a map
 * keyed by source memory id. Best-effort: a failure returns an empty
 * map rather than throwing - the list matters more than the graph
 * layer, and the next load retries. Shared by the browse-page and
 * search paths so both render edges per-card without an await-per-row.
 */
async function fetchRelationsMap(
  supabase: SupabaseService,
  ids: string[],
): Promise<Map<string, MemoryRelation[]>> {
  const map = new Map<string, MemoryRelation[]>();
  if (ids.length === 0) return map;
  try {
    const edges = await supabase.listMemoryRelationsFor(ids);
    for (const edge of edges) {
      const list = map.get(edge.from_memory_id);
      if (list) list.push(edge);
      else map.set(edge.from_memory_id, [edge]);
    }
  } catch {
    // Swallow - see doc comment.
  }
  return map;
}

/**
 * Load the memory browse list from the first page (empty-query
 * regime). Resets the offset window, hydrates relations for the page,
 * and refreshes the topic vocabulary. Called by the sidebar when the
 * query is empty - on mount, on clearing a search, and on a topic-
 * filter change.
 */
export async function loadMemoriesFirstPage(
  supabase: SupabaseService,
): Promise<void> {
  // Supersede any in-flight semantic search so a slow embed from a
  // just-cleared query can't clobber the fresh browse list.
  if (currentAbort) currentAbort.abort();
  memoriesStore.loading = true;
  memoriesStore.error = null;
  try {
    const page = await supabase.listMemoriesPage({
      offset: 0,
      pageSize: MEMORIES_LIST_LIMIT,
      selectedTopics: memoriesStore.selectedTopics,
    });
    memoriesStore.results = page.rows;
    memoriesStore.offset = page.rows.length;
    memoriesStore.hasMore = page.hasMore;
    memoriesStore.relations = await fetchRelationsMap(
      supabase,
      page.rows.map((m) => m.id),
    );
    void refreshMemoriesTopicsVocabulary(supabase);
  } catch (err) {
    memoriesStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    memoriesStore.loading = false;
    memoriesStore.loaded = true;
  }
}

/**
 * Append the next browse page. No-op while a page is in flight, when
 * the list is drained, or when a search is active (search results
 * aren't paged), so the sidebar sentinel can fire it freely. A failed
 * page leaves `hasMore` intact so the next scroll retries.
 */
export async function loadMoreMemories(
  supabase: SupabaseService,
): Promise<void> {
  if (memoriesStore.loadingMore || !memoriesStore.hasMore) return;
  if (memoriesStore.query.trim().length > 0) return;
  memoriesStore.loadingMore = true;
  try {
    const page = await supabase.listMemoriesPage({
      offset: memoriesStore.offset,
      pageSize: MEMORIES_LIST_LIMIT,
      selectedTopics: memoriesStore.selectedTopics,
    });
    memoriesStore.results = [...memoriesStore.results, ...page.rows];
    memoriesStore.offset += page.rows.length;
    memoriesStore.hasMore = page.hasMore;
    // Merge the new page's edges into the existing map rather than
    // replacing it - the already-loaded rows keep their edges.
    const more = await fetchRelationsMap(
      supabase,
      page.rows.map((m) => m.id),
    );
    if (more.size > 0) {
      const merged = new Map(memoriesStore.relations);
      for (const [from, edges] of more) merged.set(from, edges);
      memoriesStore.relations = merged;
    }
    memoriesStore.error = null;
  } catch (err) {
    memoriesStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    memoriesStore.loadingMore = false;
  }
}

/**
 * Drive `memoriesStore` from the bound query. The single entry point
 * every caller uses; it dispatches on the query:
 *
 *   - Empty query -> the paginated browse list (`loadMemoriesFirstPage`).
 *   - Non-empty query -> the capped semantic search below.
 *
 * Callers should debounce - this runs immediately. Cancels any
 * in-flight search so a stale result can't clobber the latest query.
 */
export async function runMemoriesSearch(
  supabase: SupabaseService,
): Promise<void> {
  if (memoriesStore.query.trim().length === 0) {
    return loadMemoriesFirstPage(supabase);
  }
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  memoriesStore.loading = true;
  memoriesStore.error = null;
  try {
    const hits = await searchMemoriesSemantic(memoriesStore.query.trim(), MEMORIES_LIST_LIMIT, {
      supabase,
      signal: ctl.signal,
      selectedTopics: memoriesStore.selectedTopics,
    });
    if (ctl.signal.aborted) return;
    memoriesStore.results = hits;
    // Search results are capped, not paged - close the sentinel so a
    // scroll to the bottom of a search doesn't try to "load more."
    memoriesStore.offset = hits.length;
    memoriesStore.hasMore = false;

    // Hydrate outbound edges in one batched RPC. A failure here just
    // leaves the relations map empty - the list is more important than
    // the graph layer, and a follow-up search will retry.
    const nextMap = await fetchRelationsMap(
      supabase,
      hits.map((m) => m.id),
    );
    if (!ctl.signal.aborted) memoriesStore.relations = nextMap;

    // Piggy-back a vocabulary refresh on every search resolution.
    // Memory writes by the background memory-topics worker land
    // server-side without going through any client-side store
    // mutation - no realtime channel today (see the cookbook-events
    // / no-memory-events note in this file's header) - so this is
    // how the dropdown picks up newly-minted topics without
    // requiring a drawer reopen. The RPC is a single distinct-array-
    // agg per user, cheap at the scale of "tens of distinct topics
    // per account", so chaining it onto every search is well under
    // the noise floor. Best-effort: a failure leaves the prior
    // vocabulary in place.
    if (!ctl.signal.aborted) await refreshMemoriesTopicsVocabulary(supabase);
  } catch (err) {
    if (ctl.signal.aborted) return;
    memoriesStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (currentAbort === ctl) currentAbort = null;
    if (!ctl.signal.aborted) {
      memoriesStore.loading = false;
      memoriesStore.loaded = true;
    }
  }
}

/**
 * Refresh the per-user topic vocabulary from
 * `list_user_memory_topics`. Called from MemoryList.svelte on first
 * load and after a memory-update realtime event lands (the topics
 * column changing is a strong signal to repopulate the dropdown).
 * Best-effort: a failure leaves the existing vocabulary in place
 * rather than blanking it, since a stale list is more useful than
 * an empty one.
 */
export async function refreshMemoriesTopicsVocabulary(
  supabase: SupabaseService
): Promise<void> {
  try {
    memoriesStore.topicsVocabulary = await supabase.listUserMemoryTopics();
  } catch {
    // swallow - see comment above
  }
}

/**
 * Replace one row in `results` without re-querying. Called from the
 * panel after `updateMemory` / `reaffirmMemoryConfidence` /
 * `doubtMemoryConfidence` so the list doesn't visually reorder while
 * the user is mid-edit.
 */
export function patchMemoryRow(id: string, patch: Partial<Memory>): void {
  memoriesStore.results = memoriesStore.results.map((m) =>
    m.id === id ? { ...m, ...patch } : m,
  );
}

/**
 * Drop one row from the list, plus any outbound or inbound edges that
 * touched it. Mirrors the DB-side ON DELETE CASCADE on
 * memory_relations FKs so the UI doesn't show ghost edges pointing at
 * (or from) a memory that no longer exists.
 */
export function removeMemoryRow(id: string): void {
  memoriesStore.results = memoriesStore.results.filter((m) => m.id !== id);
  const nextMap = new Map<string, MemoryRelation[]>();
  for (const [fromId, edges] of memoriesStore.relations) {
    if (fromId === id) continue;
    const kept = edges.filter((e) => e.to_memory_id !== id);
    if (kept.length > 0) nextMap.set(fromId, kept);
  }
  memoriesStore.relations = nextMap;
}

/**
 * Ensure a memory is present in `results` so the detail panel can
 * resolve it from a cross-link. The panel derives the open card from
 * `route.memory` against `results`; following a "Similar memories" link
 * to a row outside the active search/browse window would otherwise land
 * on the "not in the current results" empty state. Replaces an existing
 * row by id (keeping the freshest copy), otherwise prepends. The new row
 * shows no outbound relations until the next browse/search load hydrates
 * the relations map - acceptable, the graph layer is best-effort here.
 */
export function upsertMemoryRow(mem: Memory): void {
  const exists = memoriesStore.results.some((m) => m.id === mem.id);
  memoriesStore.results = exists
    ? memoriesStore.results.map((m) => (m.id === mem.id ? mem : m))
    : [mem, ...memoriesStore.results];
}

/** Append a freshly-created edge into the relations map. */
export function addRelationEdge(edge: MemoryRelation): void {
  const nextMap = new Map(memoriesStore.relations);
  const list = nextMap.get(edge.from_memory_id);
  nextMap.set(edge.from_memory_id, list ? [...list, edge] : [edge]);
  memoriesStore.relations = nextMap;
}

/** Remove a single edge from a source memory's outbound list. */
export function removeRelationEdge(fromId: string, relationId: string): void {
  const nextMap = new Map(memoriesStore.relations);
  const list = nextMap.get(fromId);
  if (!list) return;
  const filtered = list.filter((e) => e.id !== relationId);
  if (filtered.length > 0) nextMap.set(fromId, filtered);
  else nextMap.delete(fromId);
  memoriesStore.relations = nextMap;
}
