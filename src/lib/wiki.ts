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

import type { SupabaseService, WikiArticle, WikiRecord } from './supabase';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';

export interface SearchWikiDeps {
  supabase: SupabaseService;
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

/**
 * Length ceiling on a wiki record's body (8000 chars). Records are short
 * discrete jots, not consolidated articles, so the cap is tighter than
 * MAX_WIKI_CONTENT_CHARS. Mirrored in supabase/functions/_shared/
 * embed-input.ts (MAX_WIKI_RECORD_CONTENT_CHARS) and enforced at the
 * record write-tool boundary so a pre-cap row can't loop the backfill on
 * an input Venice rejects.
 */
export const MAX_WIKI_RECORD_CONTENT_CHARS = 8000;

/**
 * Max number of tags per record. A filtering facet, not prose - a
 * runaway model shouldn't be able to attach hundreds of keywords.
 */
export const MAX_WIKI_RECORD_TAGS = 24;

/**
 * Length ceiling on a single tag. Keeps the chip UI legible and the GIN
 * index entries bounded.
 */
export const MAX_WIKI_RECORD_TAG_CHARS = 40;

/**
 * Semantic search across the user's wiki records, parallel to
 * `searchWikiArticlesSemantic`. Embeds the query via Venice (silent
 * ILIKE fallback on failure, same rationale as articles) and hands the
 * embedding to `SupabaseService.searchWikiRecords`, which merges vector
 * hits with ILIKE hits deduped by id. No sole-source filter - records
 * have no provenance-exclusion semantic.
 */
/**
 * Build the one-line changelog message for a record write. Records reuse
 * the article changelog (scoped to the parent article), so each
 * create/edit/delete lands a row whose message reads like a commit
 * summary: "Added record (2026-06-17): baked an 80% loaf". Capped at
 * MAX_WIKI_CHANGELOG_MESSAGE_CHARS to satisfy the column CHECK.
 *
 * Mirrored verbatim in supabase/functions/venice/tools/_record_helpers.ts
 * (buildRecordChangelogMessage) so the chat/agent path and the in-app
 * compose path produce identical wording. Keep the two in sync.
 */
export function buildRecordChangelogMessage(
  kind: 'record_create' | 'record_update' | 'record_delete',
  date: string,
  content?: string,
): string {
  const verb =
    kind === 'record_create' ? 'Added' : kind === 'record_update' ? 'Edited' : 'Removed';
  const base = `${verb} record (${date})`;
  const preview =
    typeof content === 'string' ? content.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const full = preview ? `${base}: ${preview}` : base;
  return full.slice(0, MAX_WIKI_CHANGELOG_MESSAGE_CHARS);
}

export async function searchWikiRecordsSemantic(
  query: string,
  limit: number,
  deps: { supabase: SupabaseService; signal?: AbortSignal },
): Promise<WikiRecord[]> {
  const { supabase, signal } = deps;
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return supabase.searchWikiRecords({ query: '', queryEmbedding: null, limit });
  }
  let rawEmbedding: number[] | undefined;
  try {
    const response = await supabase.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: trimmed,
      signal,
    });
    rawEmbedding = response.data[0]?.embedding;
  } catch {
    // Silent fallback - a transient Venice error shouldn't blank the
    // records search; ILIKE-only beats a hard error.
    rawEmbedding = undefined;
  }
  const queryEmbedding =
    rawEmbedding && rawEmbedding.length > 0
      ? padEmbeddingForStorage(rawEmbedding)
      : null;
  return supabase.searchWikiRecords({ query: trimmed, queryEmbedding, limit });
}

export async function searchWikiArticlesSemantic(
  query: string,
  limit: number,
  deps: SearchWikiDeps,
): Promise<WikiArticle[]> {
  const { supabase, signal, excludeSoleSourceThreadId } = deps;
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
  } else {
    let rawEmbedding: number[] | undefined;
    try {
      const response = await supabase.embed({
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
