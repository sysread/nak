/**
 * EmbeddingSource adapter for the `memories` table — the first (and
 * today only) target of the background embeddings pipeline. See
 * `../types.ts` for the interface contract and the rationale for
 * per-source adapters over a polymorphic `embeddings` table.
 *
 * The adapter is intentionally thin: the heavy lifting (claim, save with
 * concurrency guard) lives in Postgres RPCs on SupabaseService so every
 * touch goes through the same RLS-scoped client. The adapter just shapes
 * the two calls and builds the embedding input string.
 */
import type { SupabaseService } from '../../supabase';
import type { EmbeddingSource, PendingItem } from '../types';
import { MAX_MEMORY_DATA_CHARS } from '../types';

/**
 * Compose the string Venice actually embeds. The label carries a lot of
 * semantic weight for short notes ("gym PIN", "mom's birthday") so we
 * prepend it verbatim — the double-newline is a soft boundary that
 * biases the model to weigh the label against the body rather than
 * smearing them.
 *
 * Truncation is defensive. `memory_create`/`memory_update` already
 * reject inputs over MAX_MEMORY_DATA_CHARS at the tool boundary, but
 * historical rows written before that cap landed may still exceed it.
 * Silent truncate here means the worker can process them instead of
 * looping forever on a row Venice rejects for context overflow.
 *
 * Exported for direct unit testing — the truncation boundary is the
 * kind of off-by-one that silently corrupts an embedding, so it's worth
 * a dedicated test.
 */
export function buildMemoryEmbedInput(label: string, data: string): string {
  const body =
    data.length > MAX_MEMORY_DATA_CHARS ? data.slice(0, MAX_MEMORY_DATA_CHARS) : data;
  return `${label}\n\n${body}`;
}

export function createMemoriesSource(supabase: SupabaseService): EmbeddingSource {
  return {
    name: 'memories',
    async claimNext(holderId: string, ttlSeconds: number): Promise<PendingItem | null> {
      const row = await supabase.claimNextPendingMemory(holderId, ttlSeconds);
      if (!row) return null;
      return { id: row.id, input: buildMemoryEmbedInput(row.label, row.data) };
    },
    async save(
      id: string,
      holderId: string,
      embedding: number[],
      model: string
    ): Promise<boolean> {
      return supabase.saveMemoryEmbedding(id, holderId, embedding, model);
    },
  };
}
