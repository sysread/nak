// memory_consolidate (function-side port)
//
// Merge two duplicate memories into one. The memory librarians' (rem,
// deep-sleep) single content-write primitive; not reachable from
// reflection or the main chat (consolidation is a cross-row decision
// the per-turn agents shouldn't be making). Wire schema lives with the
// librarian toolbox in agents/_memory_librarian_tools.ts.
//
// The heavy lifting lives in the `consolidate_memories` Postgres RPC
// so the four-step sequence (write survivor content + max confidence,
// halve loser, redirect memory_conversation rows, redirect
// memory_relations edges with self-loop and duplicate cleanup) runs
// in one transaction. See supabase/schema.sql for the rationale on
// each step. Auth: b-strict - the RPC takes p_user_id and enforces
// per-row ownership against it (the admin client bypasses RLS, so
// those explicit checks are the whole guarantee).
//
// Confidence-handling note: the survivor's post-merge confidence is
// `greatest(survivor.confidence, loser.confidence)`, NOT a bump.
// Two threads independently producing the same fact IS corroboration,
// but we preserve the strongest existing evidence rather than
// manufacturing new evidence - repeated consolidation passes would
// otherwise systematically inflate the store.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { appendMemoryChangelog } from './_memory_changelog.ts';
import {
  memoryDataBudgetError,
  readMemoryDataLengths,
} from './_memory_data_budget.ts';
import { ArgErrors } from './_validate.ts';

export const memoryConsolidate: ToolDef = {
  name: 'memory_consolidate',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const survivorId =
      typeof args.survivor_id === 'string' ? args.survivor_id.trim() : '';
    const loserId = typeof args.loser_id === 'string' ? args.loser_id.trim() : '';
    const label = typeof args.label === 'string' ? args.label.trim() : '';
    const data = typeof args.data === 'string' ? args.data : '';

    const errs = new ArgErrors();
    if (!survivorId) errs.add('survivor_id is required');
    if (!loserId) errs.add('loser_id is required');
    // Only meaningful once both ids are present; otherwise the empty-string
    // pair would spuriously read as equal.
    if (survivorId && loserId && survivorId === loserId) {
      errs.add('survivor_id and loser_id must differ');
    }
    // One read serves the non-growth budget and the changelog's
    // before-size. Keyed by id because the changelog stamp needs the
    // SURVIVOR specifically, while the budget wants both inputs.
    const priorLengths =
      survivorId && loserId
        ? await readMemoryDataLengths(ctx.adminClient, ctx.userId, [
            survivorId,
            loserId,
          ])
        : new Map<string, number>();

    if (label.length === 0) errs.add('label is required');
    if (data.length === 0) errs.add('data is required');
    else if (survivorId && loserId) {
      // Non-growth rule, keyed off BOTH merge inputs: collapsing two rows
      // that encode the same fact has no business producing something
      // longer than the longer input. This is the check that stops
      // repeated consolidation passes from ratcheting a body upward.
      const overBudget = memoryDataBudgetError(data, [...priorLengths.values()]);
      if (overBudget) {
        errs.add(
          `${overBudget} Consolidation needs a single condensed body, not the ` +
            'concatenation of two.',
        );
      }
    }
    errs.throwIfAny();

    // Snapshot the loser's label before the merge so the changelog
    // message reads "Merged X into this". Best-effort and resilient:
    // the label is only used to phrase the message, so a fetch failure
    // (or a stale loser id) must not abort the consolidation - it just
    // falls back to generic phrasing. Kept outside the consolidate
    // call so the RPC's own errors still propagate verbatim.
    let loserLabel: string | undefined;
    try {
      // RLS OFF: filter by userId.
      const { data: loser } = await ctx.adminClient
        .from('memories')
        .select('label')
        .eq('id', loserId)
        .eq('user_id', ctx.userId)
        .maybeSingle();
      loserLabel = (loser as { label: string } | null)?.label.trim() || undefined;
    } catch {
      // best-effort; generic phrasing below covers the missing label.
    }

    const { data: confidence, error } = await ctx.adminClient.rpc(
      'consolidate_memories',
      {
        p_survivor_id: survivorId,
        p_loser_id: loserId,
        p_new_label: label,
        p_new_data: data,
        p_user_id: ctx.userId,
      },
    );
    if (error) throw new Error(`consolidateMemories failed: ${error.message}`);
    if (typeof confidence !== 'number') {
      throw new Error(
        `consolidate_memories returned non-numeric: ${JSON.stringify(confidence)}`,
      );
    }

    // Record the merge as an 'update' on the survivor - consolidation is
    // the librarian's only content-write, and "combining" is exactly the
    // change the user wants visible in the changelog. The message is
    // auto-generated (the librarian tool carries no message param);
    // best-effort, like the other write paths.
    try {
      await appendMemoryChangelog(ctx.adminClient, ctx.userId, {
        memory_id: survivorId,
        kind: 'update',
        label_at_change: label,
        message: loserLabel
          ? `Merged "${loserLabel}" into this memory.`
          : 'Merged a duplicate memory into this one.',
        // The SURVIVOR's prior length, not survivor+loser combined - see
        // the column comments in schema.sql. A merge that genuinely
        // condensed shows a negative delta here even though the store
        // also shed the loser's row entirely.
        chars_before: priorLengths.get(survivorId),
        chars_after: data.length,
      });
    } catch {
      // best-effort by design
    }

    return { survivor_id: survivorId, confidence };
  },
};

registerTool(memoryConsolidate);
