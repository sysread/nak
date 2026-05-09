/**
 * Shared semantic-search pipeline for the user wiki. Parallel to
 * `src/lib/memories.ts` and `src/lib/journal-events.ts` family - the
 * UI (`src/components/WikiList.svelte`, `src/screens/Wiki.svelte`) and
 * the LLM-facing tool (`src/lib/tools/wiki_search.ts`) both call
 * `searchWikiArticlesSemantic` so the user finds what the assistant
 * finds.
 *
 * The merge contract lives in `SupabaseService.searchWikiArticles`:
 * vector hits first (RPC), then ILIKE hits the vector path missed,
 * deduped by id and capped at `limit`. This module's only job is to
 * embed the query via Venice (when available) and hand the embedding
 * to the supabase method.
 *
 * Why the silent Venice fallback: a transient Venice error here would
 * otherwise blank the drawer. ILIKE-only is strictly better than a
 * hard error from the user's POV.
 */

import type { SupabaseService, WikiArticle } from './supabase';
import type { VeniceClient } from './venice';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';

export interface SearchWikiDeps {
  supabase: SupabaseService;
  venice: VeniceClient | null;
  signal?: AbortSignal;
}

/**
 * Length ceiling on the article title. Defensive cap so a corrupt or
 * model-generated title can't balloon the prompt or break the
 * sidebar layout. The `(user_id, title)` unique index has no length
 * limit at the DB layer; this is the application-side bound.
 */
export const MAX_WIKI_TITLE_CHARS = 200;

/**
 * Length ceiling on the article body. Mirrors the journal's
 * `MAX_JOURNAL_CONTENT_CHARS = 16000`. The embedding source includes
 * title + content so the cap also protects the embedding input from
 * blowing past the embedding model's window.
 */
export const MAX_WIKI_CONTENT_CHARS = 16000;

export async function searchWikiArticlesSemantic(
  query: string,
  limit: number,
  deps: SearchWikiDeps,
): Promise<WikiArticle[]> {
  const { supabase, venice, signal } = deps;
  const trimmed = query.trim();

  // Empty query: alphabetical listing. searchWikiArticles short-
  // circuits to listWikiArticles in this branch.
  if (trimmed.length === 0) {
    return supabase.searchWikiArticles({ query: '', queryEmbedding: null, limit });
  }

  // No Venice client: ILIKE-only.
  if (!venice) {
    return supabase.searchWikiArticles({ query: trimmed, queryEmbedding: null, limit });
  }

  let rawEmbedding: number[] | undefined;
  try {
    const response = await venice.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: trimmed,
      signal,
    });
    rawEmbedding = response.data[0]?.embedding;
  } catch {
    // Silent fallback - see file-level comment.
    return supabase.searchWikiArticles({ query: trimmed, queryEmbedding: null, limit });
  }

  if (!rawEmbedding || rawEmbedding.length === 0) {
    return supabase.searchWikiArticles({ query: trimmed, queryEmbedding: null, limit });
  }

  // Pad to the column's storage dim (2048). Cosine-invariant.
  const queryEmbedding = padEmbeddingForStorage(rawEmbedding);
  return supabase.searchWikiArticles({
    query: trimmed,
    queryEmbedding,
    limit,
  });
}
