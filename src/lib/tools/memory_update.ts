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
import { MAX_MEMORY_DATA_CHARS } from '../memories';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';
import { memoryUpdateSchema } from './memory_update.schema';
import { emitMemoryChange } from '../memory-events';

export const memoryUpdate: ToolDef = {
  ...memoryUpdateSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) throw new Error('message is required');
    if (message.length > MAX_MEMORY_CHANGELOG_MESSAGE_CHARS) {
      throw new Error(
        `message exceeds ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`
      );
    }
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
    const memory = await ctx.supabase.updateMemory(id, patch);
    // Append the changelog row with the post-update label so the entry
    // references the memory by its current name. Best-effort - the
    // mutation already landed.
    try {
      await ctx.supabase.createMemoryChangelogEntry({
        memory_id: memory.id,
        kind: 'update',
        label_at_change: memory.label,
        message,
      });
    } catch {
      // best-effort; see the matching comment in memory_create.ts.
    }
    emitMemoryChange();
    return memory;
  },
};
