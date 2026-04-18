/**
 * Remove a memory by id. Returns {deleted: true} on success. RLS on the
 * memories table means this silently no-ops for ids owned by another
 * user, so the LLM can't probe for existence that way.
 */
import type { ToolDef } from './types';

export const memoryDelete: ToolDef = {
  name: 'memory_delete',
  description:
    'Delete a memory by id. Use memory_search first to find the id. ' +
    'Returns {deleted: true}.',
  shortDescription: 'remove a saved note',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory to delete.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    await ctx.supabase.deleteMemory(id);
    return { deleted: true };
  },
};
