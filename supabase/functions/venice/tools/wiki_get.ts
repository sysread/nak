// wiki_get (function-side port)
//
// Fetch one wiki article's full body by id. Returns {found: false}
// for unknown or non-owned ids (the // RLS OFF filter drops other
// users' rows). Wire schema lives in src/lib/tools/wiki_get.schema.ts.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

export const wikiGet: ToolDef = {
  name: 'wiki_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. user_id eq, then id eq, so the
    // miss-vs-not-owned branches are indistinguishable to a probing
    // caller - matches RLS behavior on the browser path.
    const { data, error } = await ctx.adminClient
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`getWikiArticleById failed: ${error.message}`);
    if (!data) return { found: false };

    return {
      found: true,
      article: {
        id: data.id as string,
        title: data.title as string,
        content: data.content as string,
        created_at: data.created_at as string,
        updated_at: data.updated_at as string,
      },
    };
  },
};

registerTool(wikiGet);
