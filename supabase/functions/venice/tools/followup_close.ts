// followup_close
//
// Mark a pending question answered. The resolution is an AUDIT stamp,
// not the persistence channel - the durable outcome reaches memories
// through the normal channels (reflection reading the transcript that
// contained the answer; a volitional memory_create when the outcome is
// clearly worth keeping). Closed loops never surface as loops again.
// Wire schema in src/lib/tools/followup_close.schema.ts. Auth: b-strict.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { MAX_FOLLOWUP_RESOLUTION_CHARS } from '../../_shared/followups.ts';
import { ArgErrors, rejectUnknownArgs } from './_validate.ts';

export const followupClose: ToolDef = {
  name: 'followup_close',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const resolution = typeof args.resolution === 'string' ? args.resolution.trim() : '';

    const errs = new ArgErrors();
    rejectUnknownArgs(errs, args, ['id', 'resolution']);
    if (!id) errs.add('id is required (from followup_list)');
    if (!resolution) errs.add('resolution is required - one line on what the answer was');
    else if (resolution.length > MAX_FOLLOWUP_RESOLUTION_CHARS) {
      errs.add(
        `resolution exceeds ${MAX_FOLLOWUP_RESOLUTION_CHARS}-char limit (got ${resolution.length})`,
      );
    }
    errs.throwIfAny();

    // RLS OFF: filter by userId. The status='open' guard makes a
    // double-close read as not-found rather than silently rewriting an
    // already-recorded resolution.
    const { data: row, error } = await ctx.adminClient
      .from('followups')
      .update({
        status: 'answered',
        resolution,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .eq('status', 'open')
      .select('id, question, status, resolution')
      .maybeSingle();
    if (error) throw new Error(`followup_close failed: ${error.message}`);
    if (!row) {
      throw new Error(
        'followup not found or already closed (use followup_list to check status)',
      );
    }
    return row;
  },
};

registerTool(followupClose);
