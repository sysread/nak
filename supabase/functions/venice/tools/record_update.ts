// record_update (function-side port)
//
// Patch a record's date, content, or tags. Wire schema lives in
// src/lib/tools/record_update.schema.ts. RLS OFF: the update filters by
// user_id so a service-role write can only touch the caller's own
// records. The DB triggers stamp updated_at and null the embedding when
// date/content change.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { ArgErrors } from './_validate.ts';
import {
  MAX_WIKI_RECORD_CONTENT_CHARS,
  RECORD_COLUMNS,
  appendRecordChangelog,
  getOwnedRecord,
  normalizeRecordDate,
  normalizeRecordTags,
} from './_record_helpers.ts';

export const recordUpdate: ToolDef = {
  name: 'record_update',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const errs = new ArgErrors();
    if (!id) errs.add('id is required');

    const patch: Record<string, unknown> = {};
    if ('date' in args && args.date !== undefined && args.date !== null) {
      const { date, error } = normalizeRecordDate(args.date);
      if (error) errs.add(error);
      else if (date) patch.date = date;
    }
    if ('content' in args && args.content !== undefined && args.content !== null) {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content) errs.add('content cannot be empty');
      else if (content.length > MAX_WIKI_RECORD_CONTENT_CHARS) {
        errs.add(
          `content exceeds ${MAX_WIKI_RECORD_CONTENT_CHARS}-char limit (got ${content.length})`,
        );
      } else patch.content = content;
    }
    if ('tags' in args && args.tags !== undefined && args.tags !== null) {
      patch.tags = normalizeRecordTags(args.tags);
    }
    if (Object.keys(patch).length === 0) {
      errs.add('nothing to update - pass at least one of date, content, tags');
    }
    errs.throwIfAny();

    // Read the prior content length before the update so the changelog
    // can stamp chars_before. getOwnedRecord also verifies ownership,
    // which the update's user_id filter already does - belt and braces.
    const prior = id
      ? await getOwnedRecord(ctx.adminClient, ctx.userId, id)
      : null;
    const priorContentLength = prior?.content.length ?? null;

    const { data: row, error } = await ctx.adminClient
      .from('wiki_records')
      .update(patch)
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .select(RECORD_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`updateWikiRecord failed: ${error.message}`);
    if (!row) throw new Error(`No record with id "${id}" found for this user.`);

    const r = row as { article_id: string; date: string; content: string };
    try {
      await appendRecordChangelog(
        ctx.adminClient,
        ctx.userId,
        r.article_id,
        'record_update',
        r.date,
        r.content,
        // Undefined (-> NULL, "unknown") when the prior read failed; a
        // tags-only edit leaves both equal, which reads as a 0 delta.
        priorContentLength ?? undefined,
        r.content.length,
      );
    } catch {
      // swallow - best-effort audit row.
    }
    return row;
  },
};

registerTool(recordUpdate);
