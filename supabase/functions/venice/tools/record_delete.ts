// record_delete (function-side port)
//
// Hard-delete one record. Wire schema lives in
// src/lib/tools/record_delete.schema.ts. RLS OFF: the delete filters by
// user_id so a service-role call can only remove the caller's own
// records. Returns {deleted: false} for an unknown/non-owned id rather
// than throwing, so a probing caller can't distinguish miss from
// not-owned.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

export const recordDelete: ToolDef = {
  name: 'record_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    const { data, error } = await ctx.adminClient
      .from('wiki_records')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .select('id');
    if (error) throw new Error(`deleteWikiRecord failed: ${error.message}`);
    return { deleted: Array.isArray(data) && data.length > 0 };
  },
};

registerTool(recordDelete);
