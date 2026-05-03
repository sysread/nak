/**
 * Reactive store shared by the Memories drawer tab. Sidebar
 * (`MemoryList.svelte`) and main panel (`Memories.svelte`) both bind
 * against `memoriesStore`, so a search keystroke in the sidebar
 * filters the panel's list and a panel-side mutation (edit, delete,
 * relate) updates the sidebar without a refetch.
 *
 * Parallel to `cookbook-store.svelte.ts` and `journal-store.svelte.ts`,
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
import type { Memory, MemoryRelation, SupabaseService } from './supabase';
import type { VeniceClient } from './venice';
import { searchMemoriesSemantic } from './memories';

interface MemoriesStore {
  results: Memory[];
  /**
   * Outbound relations keyed by source memory id. Hydrated alongside
   * `results` so the panel renders edges per-card without an
   * await-per-row.
   */
  relations: Map<string, MemoryRelation[]>;
  loading: boolean;
  /** Set true after the first `runSearch` resolves, success or error. */
  loaded: boolean;
  error: string | null;
  /** Bound to the sidebar search input. */
  query: string;
}

export const memoriesStore = $state<MemoriesStore>({
  results: [],
  relations: new Map(),
  loading: false,
  loaded: false,
  error: null,
  query: '',
});

// Match the assistant's `memory_search` per-call cap so the human UI
// never hides rows the assistant can reach.
export const MEMORIES_LIST_LIMIT = 100;

// Cancel the in-flight semantic search if the user keeps typing.
// Module-scoped so the debounce timer can reach it.
let currentAbort: AbortController | null = null;

/**
 * Run a fresh search against `memoriesStore.query`. Callers should
 * debounce - this runs immediately. Cancels any in-flight request so a
 * stale result can't clobber the latest query.
 */
export async function runMemoriesSearch(
  supabase: SupabaseService,
  venice: VeniceClient | null,
): Promise<void> {
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  memoriesStore.loading = true;
  memoriesStore.error = null;
  try {
    const hits = await searchMemoriesSemantic(memoriesStore.query.trim(), MEMORIES_LIST_LIMIT, {
      supabase,
      venice,
      signal: ctl.signal,
    });
    if (ctl.signal.aborted) return;
    memoriesStore.results = hits;

    // Hydrate outbound edges in one batched RPC. A failure here just
    // leaves the relations map empty - the list is more important than
    // the graph layer, and a follow-up search will retry.
    const nextMap = new Map<string, MemoryRelation[]>();
    if (hits.length > 0) {
      try {
        const edges = await supabase.listMemoryRelationsFor(
          hits.map((m) => m.id),
        );
        if (!ctl.signal.aborted) {
          for (const edge of edges) {
            const list = nextMap.get(edge.from_memory_id);
            if (list) list.push(edge);
            else nextMap.set(edge.from_memory_id, [edge]);
          }
        }
      } catch {
        // Swallow - see comment above.
      }
    }
    if (!ctl.signal.aborted) memoriesStore.relations = nextMap;
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
