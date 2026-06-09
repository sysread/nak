// memory_invalidate (function-side port)
//
// Soft-delete: confidence *= 0.5, no floor. The agent-only counterpart
// to the user-facing memory_delete - background agents (reflection, the
// memory librarians) never hard-delete on their own authority, they
// only decay confidence so a superseded memory drops below the search
// floor while staying recoverable. Wire schema in
// src/lib/tools/memory_invalidate.schema.ts.
//
// Same read+compute+write shape as memory_doubt rather than the
// auth.uid()-scoped decay_memory_confidence RPC: the admin client has
// no uid, so we filter by userId explicitly and compute the new value
// in TS. The 0.5 factor mirrors that RPC (decay_memory_confidence
// halves without a floor).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

const INVALIDATE_FACTOR = 0.5;

export const memoryInvalidate: ToolDef = {
  name: 'memory_invalidate',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. See memory_doubt for the
    // read+compute+write rationale.
    const { data: row, error: readErr } = await ctx.adminClient
      .from('memories')
      .select('confidence')
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (readErr) {
      throw new Error(`invalidateMemoryConfidence (read) failed: ${readErr.message}`);
    }
    if (!row) throw new Error(`memory ${id} not found or not owned by this user`);

    const current = typeof (row as { confidence: number }).confidence === 'number'
      ? (row as { confidence: number }).confidence
      : 1.0;
    const next = current * INVALIDATE_FACTOR;

    // RLS OFF: filter by userId on the update.
    const { error: writeErr } = await ctx.adminClient
      .from('memories')
      .update({ confidence: next })
      .eq('id', id)
      .eq('user_id', ctx.userId);
    if (writeErr) {
      throw new Error(`invalidateMemoryConfidence (write) failed: ${writeErr.message}`);
    }

    return { id, confidence: next };
  },
};

registerTool(memoryInvalidate);
