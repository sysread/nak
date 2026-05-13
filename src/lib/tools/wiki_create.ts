/**
 * Persist a new wiki article. Returns the created row so the caller
 * (autonomous wiki agent or the chat-side tool path - though this tool
 * is agent-only today) can reference its id in a follow-up update.
 *
 * Title uniqueness is enforced at the DB level (unique (user_id, title)).
 * The Postgres unique-violation surfaces here as a SupabaseError; we
 * detect and rephrase it as actionable text the agent can read so it
 * knows to fall back to wiki_search + wiki_update.
 *
 * Source attribution: when this tool is invoked by the autonomous wiki
 * agent (ctx.threadId is non-empty), the current thread is automatically
 * attached to the new article's bibliography in wiki_article_sources.
 * The model is not asked to handle source tracking - the entire
 * attribution flow lives on the tool side.
 */
import type { ToolDef } from './types';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../wiki';
import { wikiCreateSchema } from './wiki_create.schema';
import { emitWikiChange } from '../wiki-events';

export const wikiCreate: ToolDef = {
  ...wikiCreateSchema,
  async execute(args, ctx) {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!title) throw new Error('title is required');
    if (!content) throw new Error('content is required');
    if (!message) throw new Error('message is required');
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
    if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      throw new Error(
        `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`
      );
    }
    try {
      const article = await ctx.supabase.createWikiArticle({ title, content });
      // Auto-attach the current thread as a source. The autonomous
      // wiki agent processes exactly one thread per cycle and that
      // thread's id is in ctx.threadId; the librarian (which doesn't
      // have wiki_create) would never reach this branch. The attach
      // is a best-effort secondary write - if it fails, the article
      // is still created and the user just doesn't see the thread in
      // the bibliography. Throwing here would force a duplicate-title
      // retry, which is worse than a missing source row.
      if (ctx.threadId) {
        try {
          await ctx.supabase.attachWikiArticleSources(article.id, [ctx.threadId]);
        } catch {
          // best-effort; see comment above.
        }
      }
      // Append the changelog row. Best-effort - the article is
      // already created at this point; a failure here would leave
      // an article on disk without a matching changelog entry, which
      // is a smaller harm than throwing back to the agent and
      // tempting it into a retry that would hit the unique-title
      // constraint.
      try {
        await ctx.supabase.createWikiChangelogEntry({
          article_id: article.id,
          kind: 'create',
          title_at_change: article.title,
          message,
        });
      } catch {
        // best-effort; see comment above.
      }
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
