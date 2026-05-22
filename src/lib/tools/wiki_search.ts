/**
 * Semantic + substring search over the user's wiki articles. Same
 * shape as `memory_search`: embed the query via Venice, run vector
 * cosine search against the stored embeddings, merge with an ILIKE
 * fallback so freshly-written articles still
 * participate before the embedding worker reaches them.
 *
 * Wiki articles are NEVER auto-injected into the chat - this tool is
 * the only path the assistant has to reach them.
 *
 * Sole-source exclusion: when the caller's ToolContext sets
 * `wikiExcludeOwnThreadSoleSources`, the tool passes `ctx.threadId`
 * down as the sole-source filter so an article synthesised solely from
 * the current conversation doesn't get echoed back as recall context.
 * The main chat-loop and the wiki-recall agent's inner tool loop set
 * the flag; the autonomous wiki agent and the wiki librarian leave it
 * unset because they need to FIND articles derived from the thread
 * they're processing in order to decide update-vs-create. The flag is
 * read off the ctx, not the args, so the model can't toggle it.
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
      excludeSoleSourceThreadId: ctx.wikiExcludeOwnThreadSoleSources
        ? ctx.threadId
        : null,
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
