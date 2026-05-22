/**
 * Shared semantic-search pipeline for the user wiki. Parallel to
 * `src/lib/memories.ts` - the
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
  /**
   * Sole-source exclusion. When set, drop any article whose ONLY row
   * in `wiki_article_sources` is `thread_id = excludeSoleSourceThreadId`.
   * Articles linked to other threads (or with no source rows at all)
   * still come through. Used by the `wiki_search` tool when ctx flags
   * recall-hygiene mode so a thread does not see its own synthesised
   * article echoed back as recall.
   *
   * The UI callers (WikiList.svelte, Wiki.svelte) leave this absent -
   * the browse surface wants every article regardless of provenance.
   */
  excludeSoleSourceThreadId?: string | null;
}

/**
 * Modest overfetch when the sole-source filter is active: ask the DB
 * for this many extra rows so trimming the excluded ones rarely drops
 * the final list under `limit`. A small constant rather than a
 * proportional bump because the typical filter drops 0-1 articles per
 * call (only the article(s) literally synthesised from this one thread
 * qualify); a fixed cushion covers the common case without inflating
 * the embedding-search payload.
 */
const SOLE_SOURCE_FILTER_OVERFETCH = 3;

/**
 * Length ceiling on the article title. Defensive cap so a corrupt or
 * model-generated title can't balloon the prompt or break the
 * sidebar layout. The `(user_id, title)` unique index has no length
 * limit at the DB layer; this is the application-side bound.
 */
export const MAX_WIKI_TITLE_CHARS = 200;

/**
 * Length ceiling on the article body (16000 chars). The embedding
 * source includes title + content so the cap also protects the
 * embedding input from blowing past the embedding model's window.
 */
export const MAX_WIKI_CONTENT_CHARS = 16000;

/**
 * Length ceiling on a changelog commit message. One-line summaries land
 * here, not paragraphs - the message column on `wiki_changelog` carries
 * a matching CHECK so a runaway model can't accidentally write prose
 * into the audit trail. 200 chars is the same comfortable budget a git
 * commit summary line gets; longer context belongs in the article body.
 */
export const MAX_WIKI_CHANGELOG_MESSAGE_CHARS = 200;

export async function searchWikiArticlesSemantic(
  query: string,
  limit: number,
  deps: SearchWikiDeps,
): Promise<WikiArticle[]> {
  const { supabase, venice, signal, excludeSoleSourceThreadId } = deps;
  const trimmed = query.trim();
  const filtering =
    typeof excludeSoleSourceThreadId === 'string' &&
    excludeSoleSourceThreadId.length > 0;
  // Overfetch a small constant when filtering so trimming the excluded
  // rows rarely drops below the caller's requested limit. Done at the
  // search layer (not the DB layer) because `searchWikiArticles`'
  // contract doesn't expose a sole-source exclusion - the per-article-
  // source join lives one query away.
  const fetchLimit = filtering ? limit + SOLE_SOURCE_FILTER_OVERFETCH : limit;

  let rows: WikiArticle[];
  if (trimmed.length === 0) {
    // Empty query: alphabetical listing. searchWikiArticles short-
    // circuits to listWikiArticles in this branch.
    rows = await supabase.searchWikiArticles({
      query: '',
      queryEmbedding: null,
      limit: fetchLimit,
    });
  } else if (!venice) {
    // No Venice client: ILIKE-only.
    rows = await supabase.searchWikiArticles({
      query: trimmed,
      queryEmbedding: null,
      limit: fetchLimit,
    });
  } else {
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
      rawEmbedding = undefined;
    }

    if (!rawEmbedding || rawEmbedding.length === 0) {
      rows = await supabase.searchWikiArticles({
        query: trimmed,
        queryEmbedding: null,
        limit: fetchLimit,
      });
    } else {
      // Pad to the column's storage dim (2048). Cosine-invariant.
      const queryEmbedding = padEmbeddingForStorage(rawEmbedding);
      rows = await supabase.searchWikiArticles({
        query: trimmed,
        queryEmbedding,
        limit: fetchLimit,
      });
    }
  }

  if (!filtering || rows.length === 0) return rows.slice(0, limit);

  // Sole-source filter: drop articles whose only source row is the
  // excluded thread. Articles with multiple sources (cross-thread
  // syntheses) and orphans (no source rows at all - absent from the
  // returned map) both stay.
  const sourcesByArticle = await supabase.listSourceThreadIdsForArticles(
    rows.map((a) => a.id)
  );
  const kept: WikiArticle[] = [];
  for (const article of rows) {
    const sources = sourcesByArticle.get(article.id);
    if (sources && sources.size === 1 && sources.has(excludeSoleSourceThreadId)) {
      continue;
    }
    kept.push(article);
    if (kept.length >= limit) break;
  }
  return kept;
}
