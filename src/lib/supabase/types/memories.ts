/**
 * Memory-domain row types: memories, their changelog, similarity hits,
 * the relations graph, and the rem / deep-sleep manual-run result
 * unions. Re-exported through `../../supabase.ts` so consumers keep
 * importing from `$lib/supabase`.
 */

// --- appended verbatim from the original supabase.ts type block ---
/**
 * A saved memory — label + free-form data, per-user. The `embedding` column
 * exists on the table but we deliberately don't ship it to the client
 * (1024 floats is a lot of bytes for a list view). The embed-on-write
 * path will populate it server-side or via a dedicated client method.
 *
 * `confidence` is the volitional-memory layer's trust scalar. Default 1.0
 * on create, capped at 10.0. The reflection agent's `memory_invalidate`
 * halves it; the chat-side `memory_reaffirm` / `memory_doubt` tools
 * nudge it (+0.5 and ×0.7 respectively). Below 0.05 the memory hides
 * from search (soft-delete). The field is required everywhere `Memory`
 * rides because the Memories UI and opening-recall both format a
 * qualitative tag from it - see MEMORY_CONFIDENCE_* in src/lib/memories.ts.
 */
export interface Memory {
  id: string;
  label: string;
  data: string;
  confidence: number;
  /**
   * Topic tags written by the server-side memory-topics agent
   * (supabase/functions/venice/agents/memory_topics.ts). Empty array
   * means "untagged" -
   * either the agent hasn't reached the row yet, it ran and
   * chose to emit nothing, or the user just edited the row (the
   * `clear_memory_topics_on_change` trigger nulls last_topics_at on
   * content change and the next sweep re-tags). The
   * UNTAGGED_TOPIC_SENTINEL is a UI-only primitive and never lands
   * in this column.
   */
  topics: string[];
  created_at: string;
  updated_at: string;
}

/**
 * One row of the memory changelog: a single content-affecting mutation
 * (create / update / delete, plus librarian consolidations recorded as
 * an 'update' on the survivor) captured at the time of the change.
 * `memory_id` is null when the underlying memory has since been
 * hard-deleted (the FK uses ON DELETE SET NULL); `label_at_change` is
 * the snapshot taken at write time so the row still reads meaningfully
 * without a join. See the matching table + RLS in
 * `supabase/schema.sql:memory_changelog`. Parallel to WikiChangelogEntry.
 */
export type MemoryChangelogKind = 'create' | 'update' | 'delete';
export interface MemoryChangelogEntry {
  id: string;
  memory_id: string | null;
  kind: MemoryChangelogKind;
  label_at_change: string;
  message: string;
  created_at: string;
  /**
   * Body length either side of the change, powering the size-delta chip
   * in the history panel. `null` means unknown - a row written before
   * these columns existed, whose size cannot be reconstructed. That is
   * distinct from `0`, which means genuinely empty (nothing before a
   * create, nothing after a delete). See the column comments in
   * supabase/schema.sql.
   */
  chars_before: number | null;
  chars_after: number | null;
}

/**
 * A memory plus its match score, returned by `search_memories_similar`.
 * `similarity` is the boosted-cosine value the RPC ranks on (raw cosine
 * times the bounded confidence boost), so it's monotonic with the result
 * order and can edge slightly above 1.0 for a near-identical, highly-
 * corroborated neighbour. The extra field is harmless where a plain
 * `Memory` is expected, so these rows feed `upsertMemoryRow` directly.
 */
export interface SimilarMemory extends Memory {
  similarity: number;
}

/**
 * A directed edge between two memories in the volitional-memory graph.
 * The LLM draws these via the memory_relate tool; the user can add and
 * remove them in the Memories UI. Retrieval traverses outbound edges
 * one hop deep so the LLM sees linked context alongside a match.
 *
 * `to_label` / `to_data` / `to_confidence` are the target memory's
 * display fields, joined in by `get_memory_relations` so consumers can
 * render the edge inline without a second round-trip.
 */
export interface MemoryRelation {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  kind: 'supports' | 'contradicts' | 'generalises' | 'specialises';
  note: string | null;
  created_at: string;
  to_label: string;
  to_data: string;
  to_confidence: number;
}

/**
 * Outcome of a server-side manual rem run (the venice function's
 * /rem-run route; see runRem below). Same `busy` contract as the
 * wiki librarian: the shared memory-librarian in-flight guard turns
 * a collision with a scheduled or deep-sleep run into a clean
 * "try again in a moment" instead of two passes racing.
 */
export type RemRunResult =
  | { kind: 'ok'; finalText: string; toolCalls: number; conversationsProcessed: number }
  | { kind: 'empty-queue' }
  | { kind: 'busy' }
  | { kind: 'error'; error: string };

/** Outcome of a server-side manual deep-sleep run (/deep-sleep-run; see runDeepSleep). */
export type DeepSleepRunResult =
  | { kind: 'ok'; finalText: string; toolCalls: number; batchSize: number }
  | { kind: 'no-eligible' }
  | { kind: 'too-small'; batchSize: number }
  | { kind: 'busy' }
  | { kind: 'error'; error: string };


export function coerceMemoryChangelogKind(raw: unknown): MemoryChangelogKind | null {
  if (raw === 'create' || raw === 'update' || raw === 'delete') return raw;
  return null;
}

export function coerceMemoryChangelogEntry(
  raw: Record<string, unknown>
): MemoryChangelogEntry | null {
  const id = raw.id;
  const kind = coerceMemoryChangelogKind(raw.kind);
  if (typeof id !== 'string' || !kind) return null;
  const memoryIdRaw = raw.memory_id;
  return {
    id,
    memory_id:
      typeof memoryIdRaw === 'string' && memoryIdRaw.length > 0
        ? memoryIdRaw
        : null,
    kind,
    label_at_change:
      typeof raw.label_at_change === 'string' ? raw.label_at_change : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    created_at: String(raw.created_at ?? ''),
    // Anything non-numeric coerces to null ("unknown size"), which is
    // what a pre-columns row carries. Coercing to 0 instead would make
    // an unrecorded size render as an empty body.
    chars_before: coerceCharCount(raw.chars_before),
    chars_after: coerceCharCount(raw.chars_after),
  };
}

function coerceCharCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
