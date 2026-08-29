// wiki_list (function-side port)
//
// Alphabetical listing of the user's wiki articles, projected to a
// compact (id + title + excerpt) shape. Wire schema lives in
// src/lib/tools/wiki_list.schema.ts; the limit + excerpt-cap
// constants are mirrored here.
//
// Auth: b-strict. wiki_articles has user_id directly so the // RLS
// OFF filter is a single .eq('user_id', userId).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirror of WIKI_LIST_DEFAULT_LIMIT / _MAX_LIMIT / _EXCERPT_CHARS in
// src/lib/tools/wiki_list.schema.ts. Same-PR sync discipline applies.
const WIKI_LIST_DEFAULT_LIMIT = 100;
const WIKI_LIST_MAX_LIMIT = 500;
const WIKI_LIST_EXCERPT_CHARS = 200;

export const wikiList: ToolDef = {
  name: 'wiki_list',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : WIKI_LIST_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(WIKI_LIST_MAX_LIMIT, Math.floor(rawLimit)),
    );

    // RLS OFF: filter by userId. wiki_articles.user_id is the
    // direct ownership column; service-role would otherwise see
    // every user's wiki.
    const { data, error } = await ctx.adminClient
      .from('wiki_articles')
      .select('id, title, content, favorite')
      .eq('user_id', ctx.userId)
      .order('title', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`listWikiArticles failed: ${error.message}`);

    return (data ?? []).map((a) => ({
      id: a.id as string,
      title: a.title as string,
      excerpt: typeof a.content === 'string' ? a.content.slice(0, WIKI_LIST_EXCERPT_CHARS) : '',
      favorite: (a as { favorite?: boolean }).favorite === true,
    }));
  },
};

registerTool(wikiList);
