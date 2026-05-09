/**
 * Patch an existing wiki article's title and/or content. Either field
 * can be omitted. Any change to title or content fires the schema
 * trigger that nulls the embedding, sending the row back to the
 * worker's pending queue.
 */
import type { ToolDef } from './types';
import { MAX_WIKI_TITLE_CHARS, MAX_WIKI_CONTENT_CHARS } from '../wiki';
import { wikiUpdateSchema } from './wiki_update.schema';
import { emitWikiChange } from '../wiki-events';

export const wikiUpdate: ToolDef = {
  ...wikiUpdateSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const patch: { title?: string; content?: string } = {};
    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      const title = args.title.trim();
      if (title.length > MAX_WIKI_TITLE_CHARS) {
        throw new Error(
          `title exceeds ${MAX_WIKI_TITLE_CHARS}-char limit (got ${title.length})`
        );
      }
      patch.title = title;
    }
    if (typeof args.content === 'string' && args.content.length > 0) {
      if (args.content.length > MAX_WIKI_CONTENT_CHARS) {
        throw new Error(
          `content exceeds ${MAX_WIKI_CONTENT_CHARS}-char limit (got ${args.content.length}); split or trim`
        );
      }
      patch.content = args.content;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('provide at least one of title or content');
    }
    const article = await ctx.supabase.updateWikiArticle(id, patch);
    emitWikiChange();
    return article;
  },
};
