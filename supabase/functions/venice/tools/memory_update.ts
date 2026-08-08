// memory_update (function-side port)
//
// Patch a memory's label and/or data. Either field can be omitted to
// leave it alone. Any change fires the schema trigger that nulls the
// embedding, queuing the row for re-embedding by the worker. Wire
// schema in src/lib/tools/memory_update.schema.ts.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendMemoryChangelog } from './_memory_changelog.ts';
import {
  memoryDataBudgetError,
  readMemoryDataLengths,
} from './_memory_data_budget.ts';
import { ArgErrors, rejectUnknownArgs } from './_validate.ts';

const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;

export const memoryUpdate: ToolDef = {
  name: 'memory_update',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';

    const errs = new ArgErrors();
    rejectUnknownArgs(errs, args, ['id', 'label', 'data', 'message', 'confidence']);
    if (!id) errs.add('id is required');
    // The changelog message is optional: when the model omits it we
    // synthesize one from the row's label so an edit never blocks on it.
    // Models were observed omitting message (or inventing param names to
    // carry it) and round-tripping the rejection; defaulting removes the
    // field as a failure surface, mirroring memory_create.
    if (message.length > MAX_MEMORY_CHANGELOG_MESSAGE_CHARS) {
      errs.add(
        `message exceeds ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
      );
    }

    // Confidence is not part of this tool's contract - it moves through
    // the graded levers (memory_reaffirm / memory_doubt). Models were
    // observed trying to set it here; silently ignoring the arg would
    // let them believe the write took, so name the right tools instead.
    if (args.confidence !== undefined) {
      errs.add(
        'memory_update does not change confidence; use memory_reaffirm ' +
          '(+0.5) or memory_doubt (x0.7) instead',
      );
    }

    // One read serves two consumers: the non-growth budget below and the
    // changelog's before-size. Empty when the row is unreadable, which
    // degrades the budget to the flat ceiling and the changelog to an
    // unknown before-size.
    const priorLengths = id
      ? await readMemoryDataLengths(ctx.adminClient, ctx.userId, [id])
      : new Map<string, number>();

    const patch: Record<string, unknown> = {};
    if (typeof args.label === 'string' && args.label.trim().length > 0) {
      patch.label = args.label.trim();
    }
    if (typeof args.data === 'string' && args.data.length > 0) {
      // Non-growth rule: a refine may condense or hold steady, never
      // inflate. See _memory_data_budget.ts for why the budget keys off
      // the row's current length rather than a flat ceiling.
      const overBudget = memoryDataBudgetError(args.data, [...priorLengths.values()]);
      if (overBudget) errs.add(overBudget);
      else patch.data = args.data;
    }
    if (Object.keys(patch).length === 0 && !errs.any) {
      // Only a meaningful complaint once the required fields and the data
      // length are otherwise clean - an empty patch alongside a bad data
      // arg would be a misleading second error for the same root cause.
      errs.add('provide at least one of label or data');
    }
    errs.throwIfAny();
    patch.updated_at = new Date().toISOString();

    // RLS OFF: filter by userId. id + user_id eq matches RLS scope.
    const { data: row, error } = await ctx.adminClient
      .from('memories')
      .update(patch)
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .single();
    if (error) throw new Error(`updateMemory failed: ${error.message}`);

    try {
      await appendMemoryChangelog(ctx.adminClient, ctx.userId, {
        memory_id: (row as { id: string }).id,
        kind: 'update',
        label_at_change: (row as { label: string }).label,
        // Post-update label: when the edit renamed the row, the derived
        // line names what the memory is now called.
        message: message || `Updated: ${(row as { label: string }).label}`,
        // Undefined (-> NULL, "unknown") when the prior read failed; a
        // label-only edit leaves both equal, which reads as a 0 delta.
        chars_before: priorLengths.get(id),
        chars_after: (row as { data?: string }).data?.length,
      });
    } catch {
      // best-effort
    }

    return row;
  },
};

registerTool(memoryUpdate);
