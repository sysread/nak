/**
 * Remove a memory by id. Returns {deleted: true} on success. RLS on the
 * memories table means this silently no-ops for ids owned by another
 * user, so the LLM can't probe for existence that way.
 */
import type { ToolDef } from './types';
import { memoryDeleteSchema } from './memory_delete.schema';

export const memoryDelete: ToolDef = {
  ...memoryDeleteSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    await ctx.supabase.deleteMemory(id);
    return { deleted: true };
  },
};
