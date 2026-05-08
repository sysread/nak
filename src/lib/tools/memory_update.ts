/**
 * Patch an existing memory's label and/or data. Either field can be
 * omitted to leave it alone, so the LLM can rename without rewriting
 * or vice versa.
 *
 * Mirrors memory_create's `data` cap — and here it matters twice: any
 * change to `label` or `data` fires the schema trigger that nulls the
 * embedding, sending the row back to the worker's pending queue, so an
 * oversize update would fail to re-embed (and the old embedding is
 * already gone).
 */
import type { ToolDef } from './types';
import { MAX_MEMORY_DATA_CHARS } from '../embeddings/types';
import { memoryUpdateSchema } from './memory_update.schema';

export const memoryUpdate: ToolDef = {
  ...memoryUpdateSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const patch: { label?: string; data?: string } = {};
    if (typeof args.label === 'string' && args.label.trim().length > 0) {
      patch.label = args.label.trim();
    }
    if (typeof args.data === 'string' && args.data.length > 0) {
      if (args.data.length > MAX_MEMORY_DATA_CHARS) {
        throw new Error(
          `data exceeds ${MAX_MEMORY_DATA_CHARS}-char limit (got ${args.data.length}); split across multiple memories`
        );
      }
      patch.data = args.data;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('provide at least one of label or data');
    }
    return ctx.supabase.updateMemory(id, patch);
  },
};
