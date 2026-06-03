// memory_reaffirm (function-side port)
//
// Volitional reaffirm: +0.5 confidence, capped at 10.0. Wire schema
// in src/lib/tools/memory_reaffirm.schema.ts.
//
// Implementation note: the browser path calls reaffirm_memory_confidence
// RPC, which is SECURITY INVOKER + auth.uid() - unusable from the
// service-role admin client (auth.uid() is null). Inlined as a
// read+compute+write pair here. The race window (two concurrent
// reaffirms on the same memory could miscount by one step) is
// theoretical and harmless for a confidence metric: a stale read
// just costs one missed +0.5 step, well below the [corroborated] tag
// boundary's granularity.
//
// If a future code path needs stronger atomicity, the right fix is a
// new SECURITY DEFINER RPC that takes p_user_id explicitly - mirror
// of commit_assistant_message's shape. Not worth the schema delta
// today.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

const REAFFIRM_DELTA = 0.5;
const CONFIDENCE_CAP = 10.0;

export const memoryReaffirm: ToolDef = {
  name: 'memory_reaffirm',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. Read current confidence first; null
    // result on miss or wrong-owner surfaces as the no-row error
    // below.
    const { data: row, error: readErr } = await ctx.adminClient
      .from('memories')
      .select('confidence')
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (readErr) throw new Error(`reaffirmMemoryConfidence (read) failed: ${readErr.message}`);
    if (!row) throw new Error(`memory ${id} not found or not owned by this user`);

    const current = typeof (row as { confidence: number }).confidence === 'number'
      ? (row as { confidence: number }).confidence
      : 1.0;
    const next = Math.min(current + REAFFIRM_DELTA, CONFIDENCE_CAP);

    // RLS OFF: filter by userId on the update.
    const { error: writeErr } = await ctx.adminClient
      .from('memories')
      .update({ confidence: next })
      .eq('id', id)
      .eq('user_id', ctx.userId);
    if (writeErr) throw new Error(`reaffirmMemoryConfidence (write) failed: ${writeErr.message}`);

    return { id, confidence: next };
  },
};

registerTool(memoryReaffirm);
