/**
 * Flat alphabetical listing of the user's wiki articles. Returns a
 * compact projection (id + title + head-of-content excerpt) so the
 * main chat model can survey the wiki shape without paying for every
 * full body. Mirrors the projection the wiki-librarian agent itself
 * receives - same excerpt cap, same alphabetical sort - so the model
 * sees the same view the librarian will see when it plans a run.
 *
 * Use cases on the chat side:
 *   - The user asks "what's in my wiki" / "how many articles do I have"
 *   - The model is planning a `wiki_librarian` invocation and needs to
 *     spot duplicates, stale stubs, or coverage gaps before writing
 *     instructions
 *   - The model wants to point the user at a specific article and
 *     needs the id to follow up with `wiki_get`
 *
 * For lookup-by-content use `wiki_search` (semantic + substring
 * fallback); this tool is the index, not the query.
 */
import type { ToolDef } from './types';
import {
  wikiListSchema,
  WIKI_LIST_DEFAULT_LIMIT,
  WIKI_LIST_MAX_LIMIT,
  WIKI_LIST_EXCERPT_CHARS,
} from './wiki_list.schema';

export const wikiList: ToolDef = {
  ...wikiListSchema,
  async execute(args, ctx) {
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : WIKI_LIST_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(WIKI_LIST_MAX_LIMIT, Math.floor(rawLimit))
    );
    const rows = await ctx.supabase.listWikiArticles({ limit });
    return rows.map((a) => ({
      id: a.id,
      title: a.title,
      excerpt: a.content.slice(0, WIKI_LIST_EXCERPT_CHARS),
    }));
  },
};
