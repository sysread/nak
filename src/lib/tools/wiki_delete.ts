/**
 * Hard-delete a wiki article. Both the autonomous wiki agent (for
 * consolidation only) and the user via the Wiki panel can land here -
 * the panel uses `supabase.deleteWikiArticle` directly rather than
 * dispatching this tool, but the tool's contract is the same.
 */
import type { ToolDef } from './types';
import { MAX_WIKI_CHANGELOG_MESSAGE_CHARS } from '../wiki';
import { wikiDeleteSchema } from './wiki_delete.schema';
import { emitWikiChange } from '../wiki-events';

export const wikiDelete: ToolDef = {
  ...wikiDeleteSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) throw new Error('message is required');
    if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      throw new Error(
        `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`
      );
    }
    // Capture the title BEFORE the delete so the changelog row can
    // carry a meaningful `title_at_change` snapshot. The FK on
    // wiki_changelog.article_id is ON DELETE SET NULL, which means an
    // article_id pointing at a now-deleted row would be silently
    // nulled - we'd lose the link AND the title if we didn't snapshot
    // here. A missing-article case (rare; the model called delete on
    // a stale id) produces an empty title and the changelog write is
    // skipped downstream rather than erroring; the delete itself is
    // already a no-op against a non-existent row.
    const article = await ctx.supabase.getWikiArticleById(id);
    await ctx.supabase.deleteWikiArticle(id);
    if (article) {
      try {
        await ctx.supabase.createWikiChangelogEntry({
          // article_id is intentionally null - the article is gone by
          // the time we land here, so retaining its id would point at
          // nothing. The title snapshot is what makes the row
          // readable.
          article_id: null,
          kind: 'delete',
          title_at_change: article.title,
          message,
        });
      } catch {
        // best-effort; see the matching comment in wiki_create.ts.
      }
    }
    emitWikiChange();
    return { id, deleted: true };
  },
};
