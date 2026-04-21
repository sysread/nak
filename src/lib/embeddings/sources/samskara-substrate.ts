/**
 * EmbeddingSource adapter for the `samskara_substrate` table. Mirrors
 * `./memories.ts` exactly in shape — same claim-then-save protocol,
 * same lease guard — but against a different table and a different
 * input string composition.
 *
 * Substrate rows arrive in two pending states:
 *
 *   - `situation is null` — needs assimilation by the formation
 *     worker's assimilator phase. NOT this source's responsibility;
 *     the formation worker handles assimilation independently.
 *   - `situation is not null AND situation_embedding is null` —
 *     ready to embed. This is what we claim and process here.
 *
 * The claim RPC enforces both predicates in its WHERE clause, so we
 * never accidentally embed an unassimilated row.
 */
import type { SupabaseService } from '../../supabase';
import type { EmbeddingSource, PendingItem } from '../types';

/**
 * Build the string Venice embeds for a substrate row. We concatenate
 * the situation (the assimilator's third-person observation of the
 * round) and the optional outcome (what the assistant did and how it
 * landed). Outcome carries semantic weight separate from situation —
 * a friendly response to a tense situation is a different signal than
 * the same response to a celebratory one — so a soft boundary
 * (double newline) keeps both visible to the embedding model rather
 * than smearing them.
 *
 * Truncation is defensive. There's no schema-level cap on substrate
 * field length yet (the assimilator agent's prompt asks for short
 * descriptions but a future change might lift that), and the
 * embedding model's context is finite. 8000 chars matches the
 * memory-side cap and leaves headroom for tokenizer inflation.
 *
 * Exported for unit testing — the truncation boundary is the kind of
 * off-by-one that silently corrupts an embedding, worth a dedicated
 * test.
 */
export function buildSubstrateEmbedInput(
  situation: string,
  outcome: string | null
): string {
  const trimmedSituation = situation.length > 6000 ? situation.slice(0, 6000) : situation;
  if (!outcome || outcome.length === 0) return trimmedSituation;
  const trimmedOutcome = outcome.length > 2000 ? outcome.slice(0, 2000) : outcome;
  return `${trimmedSituation}\n\n${trimmedOutcome}`;
}

export function createSamskaraSubstrateSource(
  supabase: SupabaseService
): EmbeddingSource {
  return {
    name: 'samskara-substrate',
    async claimNext(holderId: string, ttlSeconds: number): Promise<PendingItem | null> {
      const row = await supabase.samskaraClaimNextSubstrateEmbed(holderId, ttlSeconds);
      if (!row) return null;
      return {
        id: row.id,
        input: buildSubstrateEmbedInput(row.situation, row.outcome),
      };
    },
    async save(
      id: string,
      holderId: string,
      embedding: number[],
      model: string
    ): Promise<boolean> {
      return supabase.samskaraSaveSubstrateEmbedding(id, holderId, embedding, model);
    },
  };
}
