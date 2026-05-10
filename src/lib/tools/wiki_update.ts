/**
 * Patch an existing wiki article's title and/or content. Either field
 * can be omitted. Any change to title or content fires the schema
 * trigger that nulls the embedding, sending the row back to the
 * worker's pending queue.
 */
import type { ToolDef } from './types';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  findUnknownCidLinks,
} from '../wiki';
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
      // Validate any `?cid=<uuid>` source-conversation links the
      // agent embedded in the article body. See wiki_create.ts for
      // the matching rationale - this is the defense-in-depth that
      // catches a fabricated thread id at the tool boundary.
      const unknownLinks = await findUnknownCidLinks(ctx.supabase, args.content);
      if (unknownLinks.length > 0) {
        throw new Error(
          `content contains source-conversation link(s) to thread id(s) ` +
            `that do not exist for this user: ${unknownLinks.join(', ')}. ` +
            `Only use thread ids you saw in your input or in conversation_search ` +
            `results; never invent. Retry without the offending ?cid= link(s).`
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
