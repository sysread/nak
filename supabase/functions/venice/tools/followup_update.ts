// followup_update
//
// The reschedule/revise verb. A plan that MOVED ("we ate out, I'm
// making it tomorrow") is neither answered nor dismissed - the row
// keeps its identity and surfacing ledger, and only the fields that
// changed are rewritten. Wire schema in
// src/lib/tools/followup_update.schema.ts. Auth: b-strict.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  MAX_FOLLOWUP_CONTEXT_CHARS,
  MAX_FOLLOWUP_QUESTION_CHARS,
} from '../../_shared/followups.ts';
import { ArgErrors } from './_validate.ts';
import { parseRelevantAfter } from './followup_create.ts';

export const followupUpdate: ToolDef = {
  name: 'followup_update',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';

    const errs = new ArgErrors();
    if (!id) errs.add('id is required (from followup_list)');

    const patch: Record<string, unknown> = {};
    if (args.question !== undefined) {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (!question) errs.add('question, when provided, must be non-empty');
      else if (question.length > MAX_FOLLOWUP_QUESTION_CHARS) {
        errs.add(
          `question exceeds ${MAX_FOLLOWUP_QUESTION_CHARS}-char limit (got ${question.length})`,
        );
      } else patch.question = question;
    }
    if (args.context !== undefined) {
      const context = typeof args.context === 'string' ? args.context.trim() : '';
      if (context.length > MAX_FOLLOWUP_CONTEXT_CHARS) {
        errs.add(
          `context exceeds ${MAX_FOLLOWUP_CONTEXT_CHARS}-char limit (got ${context.length})`,
        );
      } else patch.context = context;
    }
    if (args.relevant_after !== undefined) {
      // Explicit null clears the date (the loop becomes semantic-only);
      // a string reschedules it.
      const parsed = parseRelevantAfter(args.relevant_after);
      if (parsed === undefined) {
        errs.add('relevant_after must be an ISO date/timestamp, or null to clear it');
      } else patch.relevant_after = parsed;
    }
    // Dependent check: only complain about an empty patch when nothing
    // else is wrong, so one root cause never reads as two errors.
    if (!errs.any && Object.keys(patch).length === 0) {
      errs.add('provide at least one of question, context, or relevant_after');
    }
    errs.throwIfAny();

    // A reschedule is a fresh ask horizon, so the surfacing ledger
    // resets when the date changes: the moved plan has not been nagged
    // about yet. Question/context-only rewording keeps the ledger.
    if ('relevant_after' in patch) {
      patch.last_surfaced_at = null;
      patch.surface_count = 0;
    }
    patch.updated_at = new Date().toISOString();

    // RLS OFF: filter by userId. Only open loops are revisable - a
    // closed loop is history; re-forming the question is a create.
    const { data: row, error } = await ctx.adminClient
      .from('followups')
      .update(patch)
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .eq('status', 'open')
      .select('id, question, context, status, relevant_after, created_at')
      .maybeSingle();
    if (error) throw new Error(`followup_update failed: ${error.message}`);
    if (!row) {
      throw new Error(
        'followup not found or not open - only open follow-ups can be updated (use followup_list to check status)',
      );
    }
    return row;
  },
};

registerTool(followupUpdate);
