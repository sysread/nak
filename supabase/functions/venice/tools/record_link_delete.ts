// record_link_delete (function-side port)
//
// Remove the directed edge from one record to another. Wire schema lives
// in src/lib/tools/record_link_delete.schema.ts. RLS OFF: the delete
// filters by user_id so a service-role call only touches the caller's
// edges. Returns {deleted: false} when no such edge exists, so a probing
// caller can't distinguish miss from not-owned. Direction matters - this
// removes the (from -> to) edge only, leaving any (to -> from) edge.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  appendRecordChangelogMessage,
  buildRecordLinkChangelogMessage,
  getOwnedRecord,
} from './_record_helpers.ts';

export const recordLinkDelete: ToolDef = {
  name: 'record_link_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const fromId = typeof args.from_record_id === 'string' ? args.from_record_id.trim() : '';
    const toId = typeof args.to_record_id === 'string' ? args.to_record_id.trim() : '';
    if (!fromId) throw new Error('from_record_id is required');
    if (!toId) throw new Error('to_record_id is required');

    const [fromRec, toRec] = await Promise.all([
      getOwnedRecord(ctx.adminClient, ctx.userId, fromId),
      getOwnedRecord(ctx.adminClient, ctx.userId, toId),
    ]);

    const { data, error } = await ctx.adminClient
      .from('wiki_record_links')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('from_record_id', fromId)
      .eq('to_record_id', toId)
      .select('id');
    if (error) throw new Error(`record_link_delete failed: ${error.message}`);
    const deleted = Array.isArray(data) && data.length > 0;

    if (deleted && fromRec && toRec) {
      try {
        await appendRecordChangelogMessage(
          ctx.adminClient,
          ctx.userId,
          fromRec.article_id,
          'record_update',
          buildRecordLinkChangelogMessage('delete', toRec.date, toRec.content, null),
        );
      } catch {
        // swallow - best-effort audit row.
      }
    }
    return { deleted };
  },
};

registerTool(recordLinkDelete);
