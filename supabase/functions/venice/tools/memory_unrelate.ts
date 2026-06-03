// memory_unrelate (function-side port)
//
// Delete one memory-relation edge by id. Hard-delete by design - the
// model expresses "this link is wrong" by adding a different edge
// (e.g. swap supports for contradicts), not by softening the existing
// one. Returns {deleted: true} unconditionally so the model's mental
// model of the CRUD surface stays consistent (matches deleteMemory).
//
// Wire schema in src/lib/tools/memory_unrelate.schema.ts.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

export const memoryUnrelate: ToolDef = {
  name: 'memory_unrelate',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. Silent no-op on a non-owned edge -
    // matches RLS behavior so the model can't probe for foreign
    // edges by id.
    const { error } = await ctx.adminClient
      .from('memory_relations')
      .delete()
      .eq('id', id)
      .eq('user_id', ctx.userId);
    if (error) throw new Error(`deleteMemoryRelation failed: ${error.message}`);

    return { deleted: true };
  },
};

registerTool(memoryUnrelate);
