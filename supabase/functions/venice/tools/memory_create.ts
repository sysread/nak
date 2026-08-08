// memory_create (function-side port)
//
// Persist a new memory and append a changelog row. Wire schema lives
// in src/lib/tools/memory_create.schema.ts. Constants mirrored from
// src/lib/memories.ts. Auth: b-strict, explicit user_id stamp.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendMemoryChangelog } from './_memory_changelog.ts';
import { MAX_MEMORY_DATA_CHARS } from './_memory_data_budget.ts';
import { ArgErrors, rejectUnknownArgs, requireFiniteNumber } from './_validate.ts';

// Mirror of MAX_MEMORY_CHANGELOG_MESSAGE_CHARS in src/lib/memories.ts.
// The data cap is single-sourced from _memory_data_budget.ts, which owns
// the length rule the rewrite paths share.
const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;

export const memoryCreate: ToolDef = {
  name: 'memory_create',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const label = typeof args.label === 'string' ? args.label.trim() : '';
    const data = typeof args.data === 'string' ? args.data : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';

    const errs = new ArgErrors();
    rejectUnknownArgs(errs, args, ['label', 'data', 'message', 'confidence']);
    if (!label) errs.add('label is required');
    if (!data) errs.add('data is required');
    else if (data.length > MAX_MEMORY_DATA_CHARS) {
      errs.add(
        `data exceeds ${MAX_MEMORY_DATA_CHARS}-char limit (got ${data.length}); split across multiple memories`,
      );
    }

    // The changelog message is the one-line summary the user reviews, not
    // part of the memory itself. It is optional: when the model omits it we
    // synthesize one from the label so a save never blocks on it. A supplied
    // message still gets the changelog length cap. Models were observed
    // dumping the full memory body into `message` and then round-tripping the
    // 200-char rejection; defaulting removes the field as a failure surface.
    const changelogMessage = message || `Created: ${label}`;
    if (changelogMessage.length > MAX_MEMORY_CHANGELOG_MESSAGE_CHARS) {
      errs.add(
        `message exceeds ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}-char limit (got ${changelogMessage.length})`,
      );
    }

    let confidence: number | undefined;
    if (args.confidence !== undefined) {
      const coerced = requireFiniteNumber(errs, 'confidence', args.confidence);
      if (coerced === null) {
        // Type error already recorded.
      } else if (coerced < 1.0 || coerced > 10.0) {
        // Name the wrong reading in the rejection: models were observed
        // sending 0-1 probabilities and retrying with more of the same
        // when the message only stated the range.
        errs.add(
          `confidence must be in [1.0, 10.0] (got ${coerced}); ` +
            'it is a decimal on a 1-10 scale, not a 0-1 probability',
        );
      } else {
        confidence = coerced;
      }
    }

    errs.throwIfAny();

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
        message: changelogMessage,
        // 0, not undefined: a create genuinely had nothing before it,
        // which is different from a pre-feature row's unknown size.
        chars_before: 0,
        chars_after: (row as { data?: string }).data?.length ?? data.length,
      });
    } catch {
      // best-effort by design
    }

    return row;
  },
};

registerTool(memoryCreate);
