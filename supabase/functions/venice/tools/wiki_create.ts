// wiki_create (function-side port)
//
// Persist a new wiki article, attach the current thread as a source,
// and append a changelog row. Wire schema lives in
// src/lib/tools/wiki_create.schema.ts. Constants mirrored from
// src/lib/wiki.ts. Auth: b-strict, explicit user_id stamp.
//
// Title uniqueness is enforced at the DB level (unique (user_id,
// lower(title))). The Postgres unique-violation is detected and
// rephrased as actionable text the agent can read, so it knows to
// fall back to wiki_search + wiki_update instead of retrying the
// create.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  appendWikiChangelog,
  attachWikiArticleSources,
} from './_wiki_helpers.ts';
import { ArgErrors } from './_validate.ts';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../../_shared/wiki-limits.ts';

export const wikiCreate: ToolDef = {
  name: 'wiki_create',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    const errs = new ArgErrors();
    if (!title) errs.add('title is required');
    else if (title.length > MAX_WIKI_TITLE_CHARS) {
      errs.add(`title exceeds ${MAX_WIKI_TITLE_CHARS}-char limit (got ${title.length})`);
    }
    if (!content) errs.add('content is required');
    else if (content.length > MAX_WIKI_CONTENT_CHARS) {
      errs.add(
        `content exceeds ${MAX_WIKI_CONTENT_CHARS}-char limit (got ${content.length}); split or trim`,
      );
    }
    if (!message) errs.add('message is required');
    else if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      errs.add(
        `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
      );
    }
    errs.throwIfAny();

    // RLS OFF: user_id stamped on insert - service-role would
    // otherwise let a row land under any owner.
    const { data: row, error } = await ctx.adminClient
      .from('wiki_articles')
      .insert({ user_id: ctx.userId, title, content })
      .select('id, title, content, created_at, updated_at')
      .single();
    if (error) {
      // Unique-violation reads as code 23505 in PostgREST's error
      // wrapper; the message form varies, so sniff both. Rephrase as
      // agent-readable so the model flips to wiki_update without
      // retrying the create.
      if (
        error.code === '23505' ||
        /duplicate key|unique constraint|23505/i.test(error.message)
      ) {
        throw new Error(
          `An article titled "${title}" already exists. Run wiki_search to find its id, then call wiki_update to integrate.`,
        );
      }
      throw new Error(`createWikiArticle failed: ${error.message}`);
    }
    const article = row as { id: string; title: string };

    // Auto-attach the current thread as a source. The autonomous wiki
    // agent processes exactly one thread per cycle and that thread's
    // id is in ctx.threadId. Best-effort secondary write - if it
    // fails, the article is still created and the user just doesn't
    // see the thread in the bibliography. Throwing here would force a
    // duplicate-title retry, which is worse than a missing source row.
    if (ctx.threadId) {
      try {
        await attachWikiArticleSources(ctx.adminClient, article.id, [ctx.threadId]);
      } catch {
        // best-effort; see comment above.
      }
    }

    // Best-effort changelog. The article is already created at this
    // point; a failure here would leave an article without a matching
    // changelog entry, which is a smaller harm than throwing back to
    // the agent and tempting it into a retry that would hit the
    // unique-title constraint.
    try {
      await appendWikiChangelog(ctx.adminClient, ctx.userId, {
        article_id: article.id,
        kind: 'create',
        title_at_change: article.title,
        message,
        // 0, not undefined: a create genuinely had nothing before it,
        // which is different from a pre-feature row's unknown size.
        chars_before: 0,
        chars_after: content.length,
      });
    } catch {
      // best-effort; see comment above.
    }

    return row;
  },
};

registerTool(wikiCreate);
