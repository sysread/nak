/**
 * Remove a single edge from the memory-relations graph. Hard-delete on
 * purpose - unlike memory_invalidate's soft-decay pattern for nodes,
 * there's no graded middle state for an edge. Either it's there or it
 * isn't. If the LLM's assessment of a link changed, that means a
 * different edge should probably exist (e.g. swap `supports` for
 * `contradicts`), not a softened version of the same one.
 *
 * The id to delete is the `id` returned by memory_relate or surfaced
 * alongside a relation in memory_search / opening-recall output. RLS
 * gates the delete to the signed-in user's own rows.
 */
import type { ToolDef } from './types';
import { memoryUnrelateSchema } from './memory_unrelate.schema';

export const memoryUnrelate: ToolDef = {
  ...memoryUnrelateSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    await ctx.supabase.deleteMemoryRelation(id);
    // deleteMemoryRelation throws on a real DB error but silently no-ops
    // for a nonexistent/non-owned id (same contract as deleteMemory).
    // Returning deleted:true unconditionally matches the rest of the
    // memory CRUD surface - the LLM's mental model stays consistent.
    return { deleted: true };
  },
};
