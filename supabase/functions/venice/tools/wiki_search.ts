// wiki_search (function-side port)
//
// Cosine-similarity search over the user's wiki articles via
// search_wiki_articles_by_embedding. Wire schema lives in
// src/lib/tools/wiki_search.schema.ts.
//
// Simplifications vs the browser path: no ILIKE merge for freshly-
// written-but-not-yet-embedded articles (the browser splices those
// in), and no sole-source exclusion (the browser's
// excludeSoleSourceThreadId filter for recall-from-own-thread
// hygiene). Both are quality-of-result polish; the v1 port returns
// vector hits as-is. If the model wants an exact-title lookup, it
// can fall back to wiki_list + filtering.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { padEmbeddingForStorage } from '../../_shared/backfill.ts';
import { localEmbed } from '../../_shared/local-embed.ts';

const WIKI_SEARCH_DEFAULT_LIMIT = 5;
const WIKI_SEARCH_MAX_LIMIT = 20;

interface WikiHit {
  id: string;
  title: string;
  content: string;
  favorite: boolean;
  created_at: string;
  updated_at: string;
  similarity: number;
}

export const wikiSearch: ToolDef = {
  name: 'wiki_search',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');

    const rawLimit =
      typeof args.limit === 'number' ? args.limit : WIKI_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(WIKI_SEARCH_MAX_LIMIT, Math.floor(rawLimit)),
    );

    let queryEmbedding: number[] | null = null;
    try {
      const raw = await localEmbed(query);
      if (raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
    } catch {
      return [];
    }
    if (!queryEmbedding) return [];

    const { data, error } = await ctx.adminClient.rpc('search_wiki_articles_by_embedding', {
      query_embedding: queryEmbedding,
      match_limit: limit,
      p_user_id: ctx.userId,
    });
    if (error) throw new Error(`searchWikiArticlesByEmbedding failed: ${error.message}`);

    return ((data ?? []) as WikiHit[]).map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      favorite: a.favorite === true,
      updated_at: a.updated_at,
      similarity: a.similarity,
    }));
  },
};

registerTool(wikiSearch);
