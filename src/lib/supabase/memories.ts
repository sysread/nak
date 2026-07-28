/**
 * Memories domain slice of the Supabase data layer: memory CRUD, the
 * memory changelog (append + paged listing), the browse-list offset
 * paging, and - under their own banner below - the confidence
 * adjustments (reaffirm/doubt), the embedding-search RPC wrappers,
 * and the memory-relations graph (create/delete/batch-list edges).
 *
 * RLS on the memories table scopes every query to the signed-in
 * user's own rows, so these functions don't need to filter by
 * user_id on select/update/delete. Inserts do need to set user_id
 * explicitly (RLS checks with_check against the row, and there's no
 * default).
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its memory
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types; the topic-filter
 * and ILIKE helpers shared with the thread / recipe paths live in
 * ./query-utils.
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { topicsFilterClause, ilikeLogicTreePattern } from './query-utils';
import type {
  Memory,
  MemoryChangelogKind,
  MemoryChangelogEntry,
  SimilarMemory,
  MemoryRelation,
  OffsetPage,
} from './types';
import { coerceMemoryChangelogEntry } from './types';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so the
 * changelog append and relation insert keep their exact error
 * behavior without reaching back into SupabaseService.
 */
async function getSession(client: SupabaseClient): Promise<Session | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw new SupabaseError(error.message);
  return data.session;
}

// Memories ---------------------------------------------------------------

/**
 * Case-insensitive substring search over `label || data`. Empty query
 * lists all memories (most-recent first). Results are capped at `limit`
 * so a runaway LLM can't blow up context with a giant memory dump.
 *
 * `selectedTopics` narrows the result set to rows whose `topics`
 * column overlaps the selection (or is empty, if the UI-only
 * UNTAGGED_TOPIC_SENTINEL is included). Empty array means "no filter
 * active" - the LLM-facing memory_search tool passes nothing here
 * because the model has no topic-selection UI, so its calls keep the
 * pre-filter behaviour exactly.
 */
export async function searchMemories(
  client: SupabaseClient,
  query: string,
  limit: number,
  selectedTopics: readonly string[] = []
): Promise<Memory[]> {
  let q = client
    .from('memories')
    .select('id, label, data, confidence, topics, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (query && query.length > 0) {
    const pattern = ilikeLogicTreePattern(query);
    q = q.or(`label.ilike.${pattern},data.ilike.${pattern}`);
  }
  const topicsClause = topicsFilterClause(selectedTopics);
  if (topicsClause) q = q.or(topicsClause);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as Memory[];
}

/**
 * Partial update. Caller guarantees at least one of label/data is set;
 * the tool-side code enforces that contract. We bump updated_at on
 * every write so memory_search orders by freshness.
 */
export async function updateMemory(
  client: SupabaseClient,
  id: string,
  patch: { label?: string; data?: string }
): Promise<Memory> {
  const { data: row, error } = await client
    .from('memories')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, label, data, confidence, topics, created_at, updated_at')
    .single();
  if (error) throw new SupabaseError(error.message);
  return row as Memory;
}

export async function deleteMemory(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('memories').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Fetch a single memory by id, or null when it doesn't exist (or is
 * owned by another user - RLS filters those rows out, so a not-found
 * and a not-owned are indistinguishable here, which is the intended
 * privacy posture). Used by the changelog write paths that need a
 * `label_at_change` snapshot before a destructive mutation: the
 * delete tool (snapshot before the row is gone) and the consolidate
 * tool (snapshot the loser's label for the merge message).
 */
export async function getMemoryById(
  client: SupabaseClient,
  id: string
): Promise<Memory | null> {
  const { data, error } = await client
    .from('memories')
    .select('id, label, data, confidence, topics, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  return (data as Memory | null) ?? null;
}

/**
 * Append a memory-changelog row. Called by every content-affecting
 * memory write path: the create/update/delete tools, the user's
 * direct edits in Memories.svelte, and the librarian's consolidate.
 * Throws on a failed insert so callers can decide whether to surface
 * or swallow it - the tool/UI paths currently swallow (the mutation
 * already landed; a missed changelog row is a smaller harm than a
 * confusing post-success error).
 *
 * `memory_id` is null for hard deletes (the memory is already gone by
 * the time this lands). For create/update/consolidate it points at
 * the live memory; if that memory is later deleted the FK cascades to
 * null but `label_at_change` keeps the row meaningful.
 */
export async function createMemoryChangelogEntry(
  client: SupabaseClient,
  args: {
    memory_id: string | null;
    kind: MemoryChangelogKind;
    label_at_change: string;
    message: string;
    /** Body length either side of the change. Omit when genuinely
     *  unknown - it lands as NULL, which the panel renders as "no size
     *  info" rather than as a zero-length body. */
    chars_before?: number;
    chars_after?: number;
  }
): Promise<void> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const label = args.label_at_change.trim();
  const message = args.message.trim();
  if (label.length === 0 || message.length === 0) return;
  const { error } = await client.from('memory_changelog').insert({
    user_id: session.user.id,
    memory_id: args.memory_id,
    kind: args.kind,
    label_at_change: label,
    message,
    chars_before: args.chars_before ?? null,
    chars_after: args.chars_after ?? null,
  });
  if (error) throw new SupabaseError(error.message);
}

/**
 * Paged listing of the memory changelog, newest first. `before` is the
 * exclusive cursor in `created_at desc` order - pass the last entry's
 * `created_at` from the prior page to fetch the next one. The
 * (user_id, created_at desc) index makes this a range scan rather than
 * a sort, so the panel can lazy-load deep history cheaply.
 */
export async function listMemoryChangelog(
  client: SupabaseClient,
  opts: {
    limit?: number;
    before?: string | null;
  } = {}
): Promise<MemoryChangelogEntry[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  let q = client
    .from('memory_changelog')
    .select(
      'id, memory_id, kind, label_at_change, message, created_at, chars_before, chars_after',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const out: MemoryChangelogEntry[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const entry = coerceMemoryChangelogEntry(row);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * One offset page of the memory browse list (most-recent first).
 * Powers the sidebar's infinite scroll for the empty-query case;
 * an active search still goes through `searchMemories` (capped, not
 * paged) so relevance order stays intact. `id` is the final tiebreak
 * so rows colliding on `updated_at` keep a stable cross-page order.
 * `selectedTopics` is filtered server-side - a partial page must be
 * narrowed before it's sliced.
 */
export async function listMemoriesPage(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
    selectedTopics?: readonly string[];
  }
): Promise<OffsetPage<Memory>> {
  let q = client
    .from('memories')
    .select('id, label, data, confidence, topics, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false });
  const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
  if (topicsClause) q = q.or(topicsClause);
  q = q.range(opts.offset, opts.offset + opts.pageSize);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as Memory[];
  const hasMore = rows.length > opts.pageSize;
  return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
}

// Memory confidence, search & relations ----------------------------------

/**
 * Chat-side reaffirm: +0.5 capped at 10.0. Gentler than the reflection
 * agent's bump (+1.0) because it fires mid-turn on a single exchange
 * rather than on settled evidence across a conversation. Returns the
 * post-adjustment value so the tool result can echo it to the LLM.
 */
export async function reaffirmMemoryConfidence(
  client: SupabaseClient,
  id: string
): Promise<number | null> {
  const { data, error } = await client.rpc(
    'reaffirm_memory_confidence',
    { p_id: id }
  );
  if (error) throw new SupabaseError(error.message);
  return typeof data === 'number' ? data : null;
}

/**
 * Chat-side doubt: ×0.7 with no floor. Gentler than the reflection
 * agent's decay (×0.5). Five doubts from 1.0 lands around 0.168
 * ([shaky] tag territory) without crashing below the 0.05 search-hide
 * floor in one hit.
 */
export async function doubtMemoryConfidence(
  client: SupabaseClient,
  id: string
): Promise<number | null> {
  const { data, error } = await client.rpc('doubt_memory_confidence', {
    p_id: id,
  });
  if (error) throw new SupabaseError(error.message);
  return typeof data === 'number' ? data : null;
}

/**
 * Cosine-similarity search via the `search_memories_by_embedding` RPC.
 * The RPC enforces `user_id = auth.uid()` in addition to RLS and hides
 * the `embedding` column from the response — 2048 floats per row is a
 * lot to ship back just to throw away. Confidence rides the row so
 * consumers can format the qualitative tag without a second round-trip.
 */
export async function searchMemoriesByEmbedding(
  client: SupabaseClient,
  queryEmbedding: number[],
  limit: number
): Promise<Memory[]> {
  const { data, error } = await client.rpc('search_memories_by_embedding', {
    query_embedding: queryEmbedding,
    match_limit: limit,
  });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as Memory[];
}

/**
 * Top-k memories most similar to a given memory, via the
 * `search_memories_similar` RPC. The source row's own stored
 * embedding is the query vector, so the ranking matches
 * `searchMemoriesByEmbedding`; the source is excluded server-side so
 * it never lists itself. Returns an empty array when the source
 * hasn't been embedded yet (the worker hasn't caught up) - the caller
 * shows an empty state. Each row carries its `similarity` match score
 * (the value the RPC ranks on); the embedding column itself is never
 * shipped.
 */
export async function searchSimilarMemories(
  client: SupabaseClient,
  memoryId: string,
  limit: number
): Promise<SimilarMemory[]> {
  const { data, error } = await client.rpc('search_memories_similar', {
    p_memory_id: memoryId,
    match_limit: limit,
  });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as SimilarMemory[];
}

/**
 * Insert a new edge in the memory-relations graph. The unique
 * constraint on (user_id, from_memory_id, to_memory_id, kind) means a
 * repeated call for the same edge raises; the tool-side handler maps
 * that to a friendlier "already exists" payload. Self-loops are
 * rejected at the tool boundary, not here.
 */
export async function createMemoryRelation(
  client: SupabaseClient,
  fromId: string,
  toId: string,
  kind: MemoryRelation['kind'],
  note: string | null
): Promise<{ id: string; kind: MemoryRelation['kind'] }> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('memory_relations')
    .insert({
      user_id: session.user.id,
      from_memory_id: fromId,
      to_memory_id: toId,
      kind,
      note,
    })
    .select('id, kind')
    .single();
  if (error) throw new SupabaseError(error.message);
  return data as { id: string; kind: MemoryRelation['kind'] };
}

/**
 * Delete a single relation by id. RLS scopes the delete to the
 * signed-in user's own rows; a wrong id (or another user's edge) is
 * silently a no-op, matching the rest of the CRUD surface here.
 */
export async function deleteMemoryRelation(
  client: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await client
    .from('memory_relations')
    .delete()
    .eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Outbound edges for a batch of memory ids, joined to the target
 * memory's display fields. Used by opening-recall (bounded traversal),
 * the memory_search tool (graph context alongside hits), and
 * Memories.svelte (per-row edge panel). Returns an empty array if
 * `ids` is empty so callers can skip a conditional.
 */
export async function listMemoryRelationsFor(
  client: SupabaseClient,
  ids: string[]
): Promise<MemoryRelation[]> {
  if (ids.length === 0) return [];
  const { data, error } = await client.rpc('get_memory_relations', {
    p_ids: ids,
  });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as MemoryRelation[];
}

/**
 * ILIKE fallback, scoped to rows the worker hasn't embedded yet. Used
 * by `memory_search` to fill in results for just-created memories —
 * without this, a memory the user wrote seconds ago would be invisible
 * until the worker catches up.
 */
export async function searchUnembeddedMemoriesByText(
  client: SupabaseClient,
  query: string,
  limit: number,
  selectedTopics: readonly string[] = []
): Promise<Memory[]> {
  if (!query || query.length === 0) return [];
  const pattern = ilikeLogicTreePattern(query);
  let q = client
    .from('memories')
    .select('id, label, data, confidence, topics, created_at, updated_at')
    .is('embedding', null)
    .or(`label.ilike.${pattern},data.ilike.${pattern}`)
    .order('updated_at', { ascending: false })
    .limit(limit);
  // Server-side topic filter on the just-written rows. Vector hits
  // are filtered client-side inside searchMemoriesSemantic (the RPC
  // returns `topics` on each row), so the two halves of the merged
  // result set agree on what "the filter is active" means without
  // needing to refactor the embedding RPC to take topic args.
  const topicsClause = topicsFilterClause(selectedTopics);
  if (topicsClause) q = q.or(topicsClause);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as Memory[];
}
