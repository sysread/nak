// followup_list
//
// The read path over the assistant's pending questions. Returns the
// open set plus a recently-closed window, because the closed rows are
// the create-side dedup evidence: before forming a follow-up, a writer
// checks "is this already open OR already answered/dismissed" - the
// answered check is the stale re-creation guard (reflection processing
// an old planning thread after the outcome landed elsewhere must not
// mint a fresh loop for a resolved plan). See docs/dev/followups.md.
// Always-on (read-only). Wire schema in
// src/lib/tools/followup_list.schema.ts. Auth: b-strict.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Open loops are few by design; closed history is windowed so the dedup
// evidence stays current without the result growing unbounded.
const OPEN_LIST_CAP = 50;
const CLOSED_LIST_CAP = 20;

export const followupList: ToolDef = {
  name: 'followup_list',
  async execute(_args: Record<string, unknown>, ctx: ToolContext) {
    // RLS OFF: filter by userId on both reads.
    const openPromise = ctx.adminClient
      .from('followups')
      .select('id, question, context, status, relevant_after, surface_count, created_at')
      .eq('user_id', ctx.userId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(OPEN_LIST_CAP);
    const closedPromise = ctx.adminClient
      .from('followups')
      .select('id, question, status, resolution, updated_at')
      .eq('user_id', ctx.userId)
      .in('status', ['answered', 'dismissed', 'expired'])
      .order('updated_at', { ascending: false })
      .limit(CLOSED_LIST_CAP);

    const [openRes, closedRes] = await Promise.all([openPromise, closedPromise]);
    if (openRes.error) throw new Error(`followup_list failed: ${openRes.error.message}`);
    if (closedRes.error) throw new Error(`followup_list failed: ${closedRes.error.message}`);
    return {
      open: openRes.data ?? [],
      recently_closed: closedRes.data ?? [],
    };
  },
};

registerTool(followupList);
