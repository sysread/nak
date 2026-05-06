/**
 * Holder-id generator shared by every background-worker manager.
 *
 * Workers stamp the value returned here on every lease row and every
 * row claim they create. Save / mark RPCs check the stamp to prove
 * a worker is finishing work it started rather than stepping on a
 * row another holder claimed - see `save_memory_embedding_if_claimed`
 * and the parallel `mark_*_if_claimed` functions in
 * `supabase/schema.sql`.
 *
 * Was previously colocated with `EmbeddingManager` because that's
 * where the first worker manager landed. Lifted out here so every
 * sibling manager (reflection, summary, journal, samskara,
 * attachment_expiry) can import it from a neutral location instead
 * of reaching sideways into embeddings.
 */

/**
 * Produce a unique id for this worker instance. Uses
 * `crypto.randomUUID()` when available; falls back to a
 * Math.random-based string on the rare host that doesn't expose it.
 *
 * The fallback is not cryptographically strong, which is fine - the
 * id only needs to be unique across a small set of peers sharing a
 * single Postgres row, not unguessable to an attacker.
 */
export function makeHolderId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `holder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
