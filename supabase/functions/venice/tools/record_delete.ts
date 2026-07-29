// record_delete (function-side port)
//
// Hard-delete one record. Wire schema lives in
// src/lib/tools/record_delete.schema.ts. RLS OFF: the delete filters by
// user_id so a service-role call can only remove the caller's own
// records. Returns {deleted: false} for an unknown/non-owned id rather
// than throwing, so a probing caller can't distinguish miss from
// not-owned.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendRecordChangelog } from './_record_helpers.ts';

export const recordDelete: ToolDef = {
  name: 'record_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // Read the doomed row first so the changelog (logged against the
    // surviving parent article) can carry its date + content preview.
    const { data: existing } = await ctx.adminClient
      .from('wiki_records')
      .select('article_id, date, content')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();

    const { data, error } = await ctx.adminClient
      .from('wiki_records')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .select('id');
    if (error) throw new Error(`deleteWikiRecord failed: ${error.message}`);
    const deleted = Array.isArray(data) && data.length > 0;

    if (deleted && existing) {
      const e = existing as { article_id: string; date: string; content: string };
      try {
        await appendRecordChangelog(
          ctx.adminClient,
          ctx.userId,
          e.article_id,
          'record_delete',
          e.date,
          e.content,
          // 0 after: the record content is genuinely gone.
          e.content.length,
          0,
        );
      } catch {
        // swallow - best-effort audit row.
      }
    }
    return { deleted };
  },
};

registerTool(recordDelete);
