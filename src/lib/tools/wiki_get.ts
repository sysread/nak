/**
 * Fetch the full body of a single wiki article by id. Used after
 * `wiki_list` once the model knows which article it wants to read in
 * full, or after `wiki_search` to confirm the body of a top match.
 *
 * Returns `{found: false}` rather than throwing when the id is unknown
 * (or belongs to another user - RLS filters it out). Matches
 * `recipe_get`'s shape so the calling model handles "not found" in
 * prose rather than guarding every call with a try/catch.
 */
import type { ToolDef } from './types';
import { wikiGetSchema } from './wiki_get.schema';

export const wikiGet: ToolDef = {
  ...wikiGetSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');
    const row = await ctx.supabase.getWikiArticleById(id);
    if (!row) return { found: false };
    return {
      found: true,
      article: {
        id: row.id,
        title: row.title,
        content: row.content,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    };
  },
};
