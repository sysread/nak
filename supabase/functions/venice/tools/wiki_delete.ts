// wiki_delete (function-side port)
//
// Hard-delete a wiki article and append a changelog row. The
// autonomous wiki agent only reaches this for consolidation (an
// article it just updated now strictly subsumes another). Wire schema
// lives in src/lib/tools/wiki_delete.schema.ts. Auth: b-strict,
// explicit user_id filter on both the read and the delete.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendWikiChangelog } from './_wiki_helpers.ts';
import { ArgErrors } from './_validate.ts';
import { MAX_WIKI_CHANGELOG_MESSAGE_CHARS } from '../../_shared/wiki-limits.ts';

export const wikiDelete: ToolDef = {
  name: 'wiki_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';

    const errs = new ArgErrors();
    if (!id) errs.add('id is required');
    if (!message) errs.add('message is required');
    else if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      errs.add(
        `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
      );
    }
    errs.throwIfAny();

    // Capture the title AND content length BEFORE the delete so the
    // changelog row can carry a meaningful title_at_change snapshot
    // and a chars_before. The FK on wiki_changelog.article_id is ON
    // DELETE SET NULL - without the snapshot we'd lose both the link
    // AND the title. A missing article (the model called delete on a
    // stale id) skips the changelog write; the delete itself is
    // already a no-op against a non-existent row.
    // Also checks the agent-edit lock: a favorited article cannot be
    // deleted by the agent. The user's own direct delete through the
    // UI (RLS, not this tool) is unaffected.
    const { data: existing, error: readErr } = await ctx.adminClient
      .from('wiki_articles')
      .select('id, title, content, favorite')
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (readErr) throw new Error(`getWikiArticleById failed: ${readErr.message}`);

    if (existing && (existing as { favorite?: boolean }).favorite === true) {
      throw new Error(
        'This article is favorited (locked) and cannot be deleted by the agent. ' +
          'The user must remove the favorite star before agent deletes are allowed.',
      );
    }

    const { error: delErr } = await ctx.adminClient
      .from('wiki_articles')
      .delete()
      .eq('id', id)
      .eq('user_id', ctx.userId);
    if (delErr) throw new Error(`deleteWikiArticle failed: ${delErr.message}`);

    if (existing) {
      try {
        await appendWikiChangelog(ctx.adminClient, ctx.userId, {
          // article_id is intentionally null - the article is gone by
          // the time this lands, so retaining its id would point at
          // nothing. The title snapshot is what makes the row
          // readable.
          article_id: null,
          kind: 'delete',
          title_at_change: (existing as { title: string }).title,
          message,
          // 0 after, not undefined: the body is genuinely gone.
          chars_before: (existing as { content?: string }).content?.length,
          chars_after: 0,
        });
      } catch {
        // best-effort; see the matching comment in wiki_create.ts.
      }
    }

    return { id, deleted: true };
  },
};

registerTool(wikiDelete);
