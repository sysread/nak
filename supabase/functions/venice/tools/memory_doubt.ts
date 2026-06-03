// memory_doubt (function-side port)
//
// Volitional doubt: confidence *= 0.7, no floor. Wire schema in
// src/lib/tools/memory_doubt.schema.ts. Same race-window caveat as
// memory_reaffirm - read+compute+write rather than the auth.uid()
// RPC since the admin client has no uid.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

const DOUBT_FACTOR = 0.7;

export const memoryDoubt: ToolDef = {
  name: 'memory_doubt',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. See memory_reaffirm for the
    // read+compute+write rationale.
    const { data: row, error: readErr } = await ctx.adminClient
      .from('memories')
      .select('confidence')
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (readErr) throw new Error(`doubtMemoryConfidence (read) failed: ${readErr.message}`);
    if (!row) throw new Error(`memory ${id} not found or not owned by this user`);

    const current = typeof (row as { confidence: number }).confidence === 'number'
      ? (row as { confidence: number }).confidence
      : 1.0;
    const next = current * DOUBT_FACTOR;

    // RLS OFF: filter by userId on the update.
    const { error: writeErr } = await ctx.adminClient
      .from('memories')
      .update({ confidence: next })
      .eq('id', id)
      .eq('user_id', ctx.userId);
    if (writeErr) throw new Error(`doubtMemoryConfidence (write) failed: ${writeErr.message}`);

    return { id, confidence: next };
  },
};

registerTool(memoryDoubt);
