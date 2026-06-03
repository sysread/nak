// memory_delete (function-side port)
//
// Hard-delete a memory by id. Returns {deleted: true} on success.
// Snapshots the label before deletion so the changelog row carries
// a readable label_at_change - the FK on memory_changelog.memory_id
// is ON DELETE SET NULL, so the post-delete memory_id is null and
// the label is what makes the row meaningful.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendMemoryChangelog } from './_memory_changelog.ts';

const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;

export const memoryDelete: ToolDef = {
  name: 'memory_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) throw new Error('message is required');
    if (message.length > MAX_MEMORY_CHANGELOG_MESSAGE_CHARS) {
      throw new Error(
        `message exceeds ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
      );
    }

    // RLS OFF: filter by userId. Read the label first so the
    // changelog row carries a snapshot - the row is about to be
    // deleted and the FK nulls memory_id, leaving label_at_change
    // as the only readable trace.
    const { data: existing, error: readErr } = await ctx.adminClient
      .from('memories')
      .select('label')
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (readErr) throw new Error(`getMemoryById failed: ${readErr.message}`);

    // RLS OFF: filter by userId on the delete itself.
    const { error: delErr } = await ctx.adminClient
      .from('memories')
      .delete()
      .eq('id', id)
      .eq('user_id', ctx.userId);
    if (delErr) throw new Error(`deleteMemory failed: ${delErr.message}`);

    if (existing) {
      try {
        await appendMemoryChangelog(ctx.adminClient, ctx.userId, {
          memory_id: null,
          kind: 'delete',
          label_at_change: (existing as { label: string }).label,
          message,
        });
      } catch {
        // best-effort
      }
    }

    return { deleted: true };
  },
};

registerTool(memoryDelete);
