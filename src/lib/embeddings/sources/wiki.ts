/**
 * EmbeddingSource adapter for the `wiki_articles` table. Lets the
 * background embeddings worker populate the `embedding` column on new
 * and edited articles so `wiki_search` can do semantic search.
 *
 * Thin wrapper over two SupabaseService RPCs (`claimNextPendingWikiArticle`
 * and `saveWikiArticleEmbedding`) plus a string-builder helper. Same
 * shape as `./memories.ts`; the generic loop in `../loop.ts` drives
 * every source the worker registers.
 */
import type { SupabaseService } from '../../supabase';
import type { EmbeddingSource, PendingItem } from '../types';
import { MAX_WIKI_CONTENT_CHARS } from '../../wiki';

/**
 * Compose the text Venice actually embeds. Title carries the topical
 * load (an article titled "kombucha" with a paragraph of body should
 * match a query for "fermented tea" via the title alone), so we lead
 * with title verbatim and double-newline before the body to give the
 * embedding model a soft boundary.
 *
 * Defensive truncation mirrors the memories adapter:
 * the tool boundary already caps content, but historical rows or
 * direct DB writes might not have, and silent truncation keeps the
 * worker from looping forever on a too-long row Venice rejects.
 */
function buildWikiEmbedInput(title: string, content: string): string {
  const body =
    content.length > MAX_WIKI_CONTENT_CHARS
      ? content.slice(0, MAX_WIKI_CONTENT_CHARS)
      : content;
  return `${title}\n\n${body}`;
}

export function createWikiSource(supabase: SupabaseService): EmbeddingSource {
  return {
    name: 'wiki',
    async claimNext(holderId: string, ttlSeconds: number): Promise<PendingItem | null> {
      const row = await supabase.claimNextPendingWikiArticle(holderId, ttlSeconds);
      if (!row) return null;
      return { id: row.id, input: buildWikiEmbedInput(row.title, row.content) };
    },
    async save(
      id: string,
      holderId: string,
      embedding: number[],
      model: string
    ): Promise<boolean> {
      return supabase.saveWikiArticleEmbedding(id, holderId, embedding, model);
    },
  };
}
