/**
 * Hard-delete a wiki article. Both the autonomous wiki agent (for
 * consolidation only) and the user via the Wiki panel can land here -
 * the panel uses `supabase.deleteWikiArticle` directly rather than
 * dispatching this tool, but the tool's contract is the same.
 */
import type { ToolDef } from './types';
import { wikiDeleteSchema } from './wiki_delete.schema';
import { emitWikiChange } from '../wiki-events';

export const wikiDelete: ToolDef = {
  ...wikiDeleteSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    await ctx.supabase.deleteWikiArticle(id);
    emitWikiChange();
    return { id, deleted: true };
  },
};
