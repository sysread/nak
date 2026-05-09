/**
 * Semantic + substring search over the user's wiki articles. Same
 * shape as `journal_search` and `memory_search`: embed the query via
 * Venice, run vector cosine search against the stored embeddings,
 * merge with an ILIKE fallback so freshly-written articles still
 * participate before the embedding worker reaches them.
 *
 * Wiki articles are NEVER auto-injected into the chat - this tool is
 * the only path the assistant has to reach them.
 */
import type { ToolDef } from './types';
import { searchWikiArticlesSemantic } from '../wiki';
import {
  wikiSearchSchema,
  WIKI_SEARCH_DEFAULT_LIMIT,
  WIKI_SEARCH_MAX_LIMIT,
} from './wiki_search.schema';

export const wikiSearch: ToolDef = {
  ...wikiSearchSchema,
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : WIKI_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(WIKI_SEARCH_MAX_LIMIT, Math.floor(rawLimit))
    );

    const rows = await searchWikiArticlesSemantic(query, limit, {
      supabase: ctx.supabase,
      venice: ctx.venice,
      signal: ctx.signal,
    });
    return rows.map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      updated_at: a.updated_at,
      ...(typeof a.similarity === 'number' ? { similarity: a.similarity } : {}),
    }));
  },
};
