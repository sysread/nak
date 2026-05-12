/**
 * EmbeddingSource adapter for the `recipes` table. Lets the background
 * embeddings worker populate the `embedding` column on new and edited
 * recipes so the drawer's recipe search can rank by meaning rather
 * than title-substring alone.
 *
 * Thin wrapper over two SupabaseService RPCs (`claimNextPendingRecipe`
 * and `saveRecipeEmbedding`); same shape as the wiki and journal
 * adapters. The generic loop in `../loop.ts` drives every source the
 * worker registers.
 */
import type { SupabaseService } from '../../supabase';
import type { EmbeddingSource, PendingItem } from '../types';

/**
 * Defensive ceiling on the embed input. A user can paste an enormous
 * recipe (long ingredient list plus a chapter of instructions) and
 * Venice rejects requests past its embedding-model token window. The
 * `recipes` table has no application-side length cap of its own
 * (cooklang is the source of truth and can run several kilobytes),
 * so the truncation lives here instead. Matches the order of
 * magnitude the journal and wiki adapters cap at.
 */
const MAX_RECIPE_EMBED_CHARS = 16000;

/**
 * Compose the text Venice embeds. Title leads (a recipe titled
 * "kombucha" should match "fermented tea" via the title path) and is
 * followed by the optional free-form `source` (e.g. "NYT Cooking -
 * Alison Roman") and then the cooklang body. Double-newline between
 * blocks gives the embedding model a soft boundary so the title
 * doesn't smear into the source line.
 */
function buildRecipeEmbedInput(
  title: string,
  source: string | null,
  cooklang: string
): string {
  const blocks: string[] = [title];
  if (source && source.trim().length > 0) blocks.push(source.trim());
  blocks.push(cooklang);
  const joined = blocks.join('\n\n');
  return joined.length > MAX_RECIPE_EMBED_CHARS
    ? joined.slice(0, MAX_RECIPE_EMBED_CHARS)
    : joined;
}

export function createRecipesSource(supabase: SupabaseService): EmbeddingSource {
  return {
    name: 'recipes',
    async claimNext(holderId: string, ttlSeconds: number): Promise<PendingItem | null> {
      const row = await supabase.claimNextPendingRecipe(holderId, ttlSeconds);
      if (!row) return null;
      return {
        id: row.id,
        input: buildRecipeEmbedInput(row.title, row.source, row.cooklang),
      };
    },
    async save(
      id: string,
      holderId: string,
      embedding: number[],
      model: string
    ): Promise<boolean> {
      return supabase.saveRecipeEmbedding(id, holderId, embedding, model);
    },
  };
}
