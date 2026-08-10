// memory_update (function-side port)
//
// Patch a memory's label, data, and/or confidence. Any field can be
// omitted to leave it alone. A label/data change fires the schema
// trigger that nulls the embedding, queuing the row for re-embedding
// by the worker; a confidence-only patch does not. Wire schema in
// src/lib/tools/memory_update.schema.ts.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendMemoryChangelog } from './_memory_changelog.ts';
import {
  memoryDataBudgetError,
  readMemoryDataLengths,
} from './_memory_data_budget.ts';
import { ArgErrors, requireFiniteNumber } from './_validate.ts';

const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;

export const memoryUpdate: ToolDef = {
  name: 'memory_update',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';

    const errs = new ArgErrors();
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
    // Direct confidence set, same [1.0, 10.0] contract as memory_create's
    // initial confidence. The graded levers (memory_reaffirm +0.5,
    // memory_doubt x0.7) remain the evidence-based path for nudges; the
    // direct set exists so a wrongly-initialized confidence can be
    // corrected without a pile of reaffirm round trips. Confidence-only
    // patches skip the embedding-reset trigger, which keys on label/data.
    if (args.confidence !== undefined) {
      const confidence = requireFiniteNumber(errs, 'confidence', args.confidence);
      if (confidence === null) {
        // Type error already recorded.
      } else if (confidence < 1.0 || confidence > 10.0) {
        errs.add(
          `confidence must be in [1.0, 10.0] (got ${confidence}); ` +
            'it is a decimal on a 1-10 scale, not a 0-1 probability',
        );
      } else {
        patch.confidence = confidence;
      }
    }

    if (Object.keys(patch).length === 0 && !errs.any) {
      // Only a meaningful complaint once the required fields and the data
      // length are otherwise clean - an empty patch alongside a bad data
      // arg would be a misleading second error for the same root cause.
      errs.add('provide at least one of label, data, or confidence');
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
