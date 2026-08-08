// followup_dismiss
//
// "Stop asking about that." Dismissal is the user's veto over a pending
// question - distinct from answered (no outcome was learned) and from
// expired (the system's own decay). Kept as a row for audit and for
// create-side dedup: a dismissed twin blocks re-forming the question
// the user waved off. Wire schema in
// src/lib/tools/followup_dismiss.schema.ts. Auth: b-strict.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { ArgErrors, rejectUnknownArgs } from './_validate.ts';

export const followupDismiss: ToolDef = {
  name: 'followup_dismiss',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const errs = new ArgErrors();
    rejectUnknownArgs(errs, args, ['id']);
    if (!id) errs.add('id is required (from followup_list)');
    errs.throwIfAny();

    // RLS OFF: filter by userId. Only open loops are dismissable.
    const { data: row, error } = await ctx.adminClient
      .from('followups')
      .update({ status: 'dismissed', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .eq('status', 'open')
      .select('id, question, status')
      .maybeSingle();
    if (error) throw new Error(`followup_dismiss failed: ${error.message}`);
    if (!row) {
      throw new Error(
        'followup not found or not open (use followup_list to check status)',
      );
    }
    return row;
  },
};

registerTool(followupDismiss);
