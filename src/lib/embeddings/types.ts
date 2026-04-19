/**
 * Shared interfaces for the background embeddings pipeline.
 *
 * The pipeline is "polymorphic code, not polymorphic data": every table
 * that wants embeddings keeps its own vector column, and registers a
 * TypeScript adapter here that knows how to claim pending rows and
 * persist results. The adjacent worker (`./worker.ts`) is the generic
 * loop that drives every registered source; the adapter under
 * `./sources/` is the per-table piece.
 *
 * Why not a single polymorphic `embeddings(source_table, source_id)`
 * table: RLS would need a branching policy per source, ugly to author
 * and slow to plan. Per-source columns give us a one-line
 * `auth.uid() = user_id` policy and cascade-delete for free.
 *
 * Why the contract is claim-one-then-save rather than batch-fetch-then-
 * batch-save: cross-device coordination. Multiple unlocked sessions
 * (laptop + phone, say) would otherwise race for the same pending rows
 * and double-bill Venice. The worker holds a singleton lease
 * (`embedding_worker_leases`) and processes rows one at a time, each
 * stamped with a per-row claim so a lease-handover never produces
 * duplicate work. See `SupabaseService.acquireEmbeddingLease` and the
 * schema comments for the full protocol.
 */

/**
 * One row that has been claimed for embedding. `input` is already
 * prepared — truncated, summarized, whatever the source needs to produce
 * a well-behaved string for Venice's `/embeddings` call.
 */
export interface PendingItem {
  id: string;
  input: string;
}

/**
 * Adapter for a single table/source. Implementations live under
 * `./sources/` and are registered with the worker at startup.
 *
 * Both methods carry the worker's `holderId` through to Postgres — the
 * claim/save RPCs guard on it so a worker that has lost the lease can't
 * clobber a row the next lease holder has since taken over.
 */
export interface EmbeddingSource {
  /** Short identifier for logs and progress reporting, e.g. `'memories'`. */
  name: string;
  /**
   * Atomically claim the next pending row and stamp it with
   * `(holderId, now + ttlSeconds)`. Returns null when there's nothing
   * to do right now — the worker treats that as "idle, sleep longer".
   */
  claimNext(holderId: string, ttlSeconds: number): Promise<PendingItem | null>;
  /**
   * Save the embedding if our claim is still valid. Returns false when
   * the row was invalidated out from under us (user edited it, TTL
   * lapsed and someone else re-claimed, row deleted). False is a normal
   * outcome — the worker logs and loops to the next row — not an error.
   */
  save(
    id: string,
    holderId: string,
    embedding: number[],
    model: string
  ): Promise<boolean>;
}

/**
 * Hard cap on memory `data` length. Enforced at the tool boundary
 * (memory_create / memory_update) AND inside the memories source adapter
 * as a defense-in-depth truncation before calling Venice.
 *
 * Chosen to stay well under the embedding model's context window (bge-m3
 * is ~512 tokens ≈ 2–4k chars; 8k leaves headroom for the label prefix
 * and worst-case tokenizer inflation) and to keep recall costs bounded —
 * `memory_search` ships the full `data` back to the LLM, so a 100k-char
 * memory would blow up every future prompt.
 */
export const MAX_MEMORY_DATA_CHARS = 8000;
