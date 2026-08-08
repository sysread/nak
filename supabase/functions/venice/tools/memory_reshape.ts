// memory_reshape (function-side, librarian-only)
//
// Rewrite a single memory's framing WITHOUT changing the facts it
// encodes or its confidence. The memory librarians (rem, deep-sleep)
// use this to clean up encoding-time poison that the reflection writer
// baked into older rows: first-person session narration ("EVIDENCE-
// CHECKING PROTOCOL EXERCISED (this conversation): I had to verify..."),
// "this conversation" / "this session" / "today" framing, and dates
// that narrate WHEN the memory was written rather than a fact. Read at
// recall time, that framing is a lie - the row's real `created_at`
// already carries when it was learned, and the context-recall smoothing
// pass anchors on that. Reshaping the stored prose into a timeless form
// lets memories heal over time instead of relying on read-time
// laundering forever.
//
// vs memory_update: mechanically the same write (label/data + changelog,
// no confidence change), but a DISTINCT contract and a distinct toolbox.
// memory_update is reflection's / the main chat's "refine a fact" verb;
// memory_reshape is the librarian's narrow "reframe, don't change the
// fact" verb. The librarian toolbox deliberately excludes memory_update
// (it "collapses, it doesn't generate"); reshape is the one sanctioned
// content rewrite, scoped by its prompt to framing-only cleanup.
//
// Auth: b-strict. id + user_id eq matches RLS scope.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendMemoryChangelog } from './_memory_changelog.ts';
import {
  memoryDataBudgetError,
  readMemoryDataLengths,
} from './_memory_data_budget.ts';
import { ArgErrors, rejectUnknownArgs } from './_validate.ts';

const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;

export const memoryReshape: ToolDef = {
  name: 'memory_reshape',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';

    const errs = new ArgErrors();
    rejectUnknownArgs(errs, args, ['id', 'label', 'data', 'message']);
    if (!id) errs.add('id is required');
    if (!message) errs.add('message is required');
    else if (message.length > MAX_MEMORY_CHANGELOG_MESSAGE_CHARS) {
      errs.add(
        `message exceeds ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
      );
    }

    // One read serves the non-growth budget and the changelog's
    // before-size. See memory_update.ts for the same pairing.
    const priorLengths = id
      ? await readMemoryDataLengths(ctx.adminClient, ctx.userId, [id])
      : new Map<string, number>();

    const patch: Record<string, unknown> = {};
    if (typeof args.label === 'string' && args.label.trim().length > 0) {
      patch.label = args.label.trim();
    }
    if (typeof args.data === 'string' && args.data.length > 0) {
      // Non-growth rule. Stripping write-time framing is the whole point
      // of a reshape, so the cleaned body should come back shorter; the
      // budget keys off the row's current length so a legacy over-ceiling
      // row can still be reframed without being forced to drop facts
      // (which its own contract forbids). See _memory_data_budget.ts.
      const overBudget = memoryDataBudgetError(args.data, [...priorLengths.values()]);
      if (overBudget) errs.add(overBudget);
      else patch.data = args.data;
    }
    if (Object.keys(patch).length === 0 && !errs.any) {
      errs.add('provide at least one of label or data to reshape');
    }
    errs.throwIfAny();
    // No confidence write: reshaping reframes an existing fact, it is
    // not new corroborating evidence. The label/data change fires the
    // schema trigger that nulls the embedding, queuing a re-embed of the
    // cleaned text.
    patch.updated_at = new Date().toISOString();

    const { data: row, error } = await ctx.adminClient
      .from('memories')
      .update(patch)
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .single();
    if (error) throw new Error(`reshapeMemory failed: ${error.message}`);

    try {
      await appendMemoryChangelog(ctx.adminClient, ctx.userId, {
        memory_id: (row as { id: string }).id,
        kind: 'update',
        label_at_change: (row as { label: string }).label,
        message,
        // A reshape that actually condensed shows up here as a negative
        // delta - the signal for whether the librarians are shrinking
        // oversized rows or just reframing them.
        chars_before: priorLengths.get(id),
        chars_after: (row as { data?: string }).data?.length,
      });
    } catch {
      // best-effort: a failed changelog insert never rolls back the
      // reshape that already landed.
    }

    return row;
  },
};

registerTool(memoryReshape);
