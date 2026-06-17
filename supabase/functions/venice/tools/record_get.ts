// record_get (function-side port)
//
// Fetch one record's full body by id. Returns {found: false} for
// unknown or non-owned ids (the user_id filter drops other users'
// rows). Wire schema lives in src/lib/tools/record_get.schema.ts.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { RECORD_COLUMNS } from './_record_helpers.ts';

export const recordGet: ToolDef = {
  name: 'record_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId, then id, so miss vs not-owned are
    // indistinguishable to a probing caller.
    const { data, error } = await ctx.adminClient
      .from('wiki_records')
      .select(RECORD_COLUMNS)
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`getWikiRecord failed: ${error.message}`);
    if (!data) return { found: false };
    return { found: true, record: data };
  },
};

registerTool(recordGet);
