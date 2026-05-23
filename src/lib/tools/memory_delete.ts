/**
 * Remove a memory by id. Returns {deleted: true} on success. RLS on the
 * memories table means this silently no-ops for ids owned by another
 * user, so the LLM can't probe for existence that way.
 */
import type { ToolDef } from './types';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';
import { memoryDeleteSchema } from './memory_delete.schema';
import { emitMemoryChange } from '../memory-events';

export const memoryDelete: ToolDef = {
  ...memoryDeleteSchema,
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
    // Capture the label BEFORE the delete so the changelog row can carry
    // a meaningful `label_at_change` snapshot. The FK on
    // memory_changelog.memory_id is ON DELETE SET NULL, so a memory_id
    // pointing at a now-deleted row would be silently nulled - we'd lose
    // the link AND the label if we didn't snapshot here. A missing-memory
    // case (the model called delete on a stale id) produces a null label
    // and the changelog write is skipped downstream; the delete itself is
    // already a no-op against a non-existent row.
    const memory = await ctx.supabase.getMemoryById(id);
    await ctx.supabase.deleteMemory(id);
    if (memory) {
      try {
        await ctx.supabase.createMemoryChangelogEntry({
          // memory_id is intentionally null - the memory is gone by the
          // time we land here, so retaining its id would point at
          // nothing. The label snapshot is what makes the row readable.
          memory_id: null,
          kind: 'delete',
          label_at_change: memory.label,
          message,
        });
      } catch {
        // best-effort; see the matching comment in memory_create.ts.
      }
    }
    emitMemoryChange();
    return { deleted: true };
  },
};
