/**
 * Persist a new wiki article. Returns the created row so the caller
 * (autonomous wiki agent or the chat-side tool path - though this tool
 * is agent-only today) can reference its id in a follow-up update.
 *
 * Title uniqueness is enforced at the DB level (unique (user_id, title)).
 * The Postgres unique-violation surfaces here as a SupabaseError; we
 * detect and rephrase it as actionable text the agent can read so it
 * knows to fall back to wiki_search + wiki_update.
 */
import type { ToolDef } from './types';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  findUnknownCidLinks,
} from '../wiki';
import { wikiCreateSchema } from './wiki_create.schema';
import { emitWikiChange } from '../wiki-events';

export const wikiCreate: ToolDef = {
  ...wikiCreateSchema,
  async execute(args, ctx) {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';
    if (!title) throw new Error('title is required');
    if (!content) throw new Error('content is required');
    if (title.length > MAX_WIKI_TITLE_CHARS) {
      throw new Error(
        `title exceeds ${MAX_WIKI_TITLE_CHARS}-char limit (got ${title.length})`
      );
    }
    if (content.length > MAX_WIKI_CONTENT_CHARS) {
      throw new Error(
        `content exceeds ${MAX_WIKI_CONTENT_CHARS}-char limit (got ${content.length}); split or trim`
      );
    }
    // Validate any `?cid=<uuid>` source-conversation links the
    // agent embedded in the article body. Constraint: agents only
    // use thread ids they got from runtime context (the current
    // thread's id, or ids returned by conversation_search). This
    // is the defense-in-depth that catches a fabricated id at the
    // tool boundary - rejecting the tool call surfaces an
    // actionable error so the agent can retry without the bad
    // link rather than landing a broken article.
    const unknownLinks = await findUnknownCidLinks(ctx.supabase, content);
    if (unknownLinks.length > 0) {
      throw new Error(
        `content contains source-conversation link(s) to thread id(s) ` +
          `that do not exist for this user: ${unknownLinks.join(', ')}. ` +
          `Only use thread ids you saw in your input or in conversation_search ` +
          `results; never invent. Retry without the offending ?cid= link(s).`
      );
    }
    try {
      const article = await ctx.supabase.createWikiArticle({ title, content });
      emitWikiChange();
      return article;
    } catch (err) {
      // Postgres unique-violation reads as code 23505 in PostgREST's
      // error wrapper. We don't have the code here, just the message,
      // so we sniff for the substring. Rephrase as agent-readable so
      // the autonomous agent flips to wiki_update without retrying.
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate key|unique constraint|23505/i.test(msg)) {
        throw new Error(
          `An article titled "${title}" already exists. Run wiki_search to find its id, then call wiki_update to integrate.`
        );
      }
      throw err;
    }
  },
};
