// record_create (function-side port)
//
// Persist a dated record linked to a wiki article. Wire schema lives in
// src/lib/tools/record_create.schema.ts. Auth: b-strict - the article
// is ownership-checked, and user_id is stamped on insert so a
// service-role write can't land under another owner.
//
// source_conversation_id is stamped from ctx.threadId when present (the
// extraction agent processes one thread per cycle; a chat-driven write
// carries the live thread), so a record records where it came from.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { ArgErrors } from './_validate.ts';
import {
  MAX_WIKI_RECORD_CONTENT_CHARS,
  RECORD_COLUMNS,
  appendRecordChangelog,
  getOwnedArticleTitle,
  normalizeRecordDate,
  normalizeRecordTags,
} from './_record_helpers.ts';

export const recordCreate: ToolDef = {
  name: 'record_create',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const articleId = typeof args.article_id === 'string' ? args.article_id.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';
    const { date, error: dateErr } = normalizeRecordDate(args.date);
    const tags = normalizeRecordTags(args.tags);

    const errs = new ArgErrors();
    if (!articleId) errs.add('article_id is required');
    if (!date) errs.add(dateErr ?? 'date is required (ISO "YYYY-MM-DD")');
    if (!content) errs.add('content is required');
    else if (content.length > MAX_WIKI_RECORD_CONTENT_CHARS) {
      errs.add(
        `content exceeds ${MAX_WIKI_RECORD_CONTENT_CHARS}-char limit (got ${content.length}); split or trim`,
      );
    }
    errs.throwIfAny();

    // Verify the article belongs to the caller before inserting a child
    // row - the admin client bypasses RLS, so without this a record
    // could be parented to another user's article. The title doubles as
    // the changelog snapshot below.
    const articleTitle = await getOwnedArticleTitle(ctx.adminClient, ctx.userId, articleId);
    if (articleTitle === null) {
      throw new Error(
        `No wiki article with id "${articleId}" found for this user. Run wiki_search or wiki_list to find a valid article id.`,
      );
    }

    const { data: row, error } = await ctx.adminClient
      .from('wiki_records')
      .insert({
        user_id: ctx.userId,
        article_id: articleId,
        date,
        content,
        tags,
        source_conversation_id: ctx.threadId ?? null,
      })
      .select(RECORD_COLUMNS)
      .single();
    if (error) throw new Error(`createWikiRecord failed: ${error.message}`);

    // Best-effort changelog (scoped to the parent article). A failure
    // here must not fail the record write - the row already landed.
    try {
      await appendRecordChangelog(
        ctx.adminClient,
        ctx.userId,
        articleId,
        'record_create',
        date as string,
        content,
      );
    } catch {
      // swallow - audit row is a convenience, the record is the truth.
    }
    return row;
  },
};

registerTool(recordCreate);
