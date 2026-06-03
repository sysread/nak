// memory_create (function-side port)
//
// Persist a new memory and append a changelog row. Wire schema lives
// in src/lib/tools/memory_create.schema.ts. Constants mirrored from
// src/lib/memories.ts. Auth: b-strict, explicit user_id stamp.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendMemoryChangelog } from './_memory_changelog.ts';

// Mirror of MAX_MEMORY_DATA_CHARS / MAX_MEMORY_CHANGELOG_MESSAGE_CHARS
// in src/lib/memories.ts.
const MAX_MEMORY_DATA_CHARS = 8000;
const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;

export const memoryCreate: ToolDef = {
  name: 'memory_create',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const label = typeof args.label === 'string' ? args.label.trim() : '';
    const data = typeof args.data === 'string' ? args.data : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!label) throw new Error('label is required');
    if (!data) throw new Error('data is required');
    if (!message) throw new Error('message is required');
    if (message.length > MAX_MEMORY_CHANGELOG_MESSAGE_CHARS) {
      throw new Error(
        `message exceeds ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
      );
    }
    if (data.length > MAX_MEMORY_DATA_CHARS) {
      throw new Error(
        `data exceeds ${MAX_MEMORY_DATA_CHARS}-char limit (got ${data.length}); split across multiple memories`,
      );
    }

    let confidence: number | undefined;
    if (args.confidence !== undefined) {
      if (typeof args.confidence !== 'number' || !Number.isFinite(args.confidence)) {
        throw new Error('confidence must be a finite number');
      }
      if (args.confidence < 1.0 || args.confidence > 10.0) {
        throw new Error(`confidence must be in [1.0, 10.0] (got ${args.confidence})`);
      }
      confidence = args.confidence;
    }

    // RLS OFF: filter by userId. memories.user_id stamped on insert -
    // service-role would otherwise let any row be created.
    const payload: Record<string, unknown> = {
      user_id: ctx.userId,
      label,
      data,
    };
    if (confidence !== undefined) payload.confidence = confidence;

    const { data: row, error } = await ctx.adminClient
      .from('memories')
      .insert(payload)
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .single();
    if (error) throw new Error(`createMemory failed: ${error.message}`);

    // Best-effort changelog. Mirrors browser path: a failure here
    // doesn't undo the memory create.
    try {
      await appendMemoryChangelog(ctx.adminClient, ctx.userId, {
        memory_id: (row as { id: string }).id,
        kind: 'create',
        label_at_change: (row as { label: string }).label,
        message,
      });
    } catch {
      // best-effort by design
    }

    return row;
  },
};

registerTool(memoryCreate);
