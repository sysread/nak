// followup_create
//
// Save a pending question the assistant wants answered later ("Ask how
// the lasagna turned out"). Wire schema lives in
// src/lib/tools/followup_create.schema.ts; the reflection agent carries
// its own wire copy. Caps come from _shared/followups.ts. Auth:
// b-strict, explicit user_id stamp. See docs/dev/followups.md.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  MAX_FOLLOWUP_CONTEXT_CHARS,
  MAX_FOLLOWUP_QUESTION_CHARS,
} from '../../_shared/followups.ts';
import { ArgErrors, rejectUnknownArgs } from './_validate.ts';

/**
 * Parse the model-supplied relevant_after into an ISO timestamptz.
 * Accepts a date ("2026-07-06") or a full timestamp. A bare date parses
 * as UTC midnight - close enough for "some time after that day", which
 * is all proactive relevance needs. Returns null for absent, a string
 * for valid, undefined for unparseable (caller records the error).
 */
export function parseRelevantAfter(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const t = Date.parse(value.trim());
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

export const followupCreate: ToolDef = {
  name: 'followup_create',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const context = typeof args.context === 'string' ? args.context.trim() : '';

    const errs = new ArgErrors();
    rejectUnknownArgs(errs, args, ['question', 'context', 'relevant_after']);
    if (!question) errs.add('question is required');
    else if (question.length > MAX_FOLLOWUP_QUESTION_CHARS) {
      errs.add(
        `question exceeds ${MAX_FOLLOWUP_QUESTION_CHARS}-char limit (got ${question.length})`,
      );
    }
    if (context.length > MAX_FOLLOWUP_CONTEXT_CHARS) {
      errs.add(
        `context exceeds ${MAX_FOLLOWUP_CONTEXT_CHARS}-char limit (got ${context.length})`,
      );
    }
    const relevantAfter = parseRelevantAfter(args.relevant_after);
    if (relevantAfter === undefined) {
      errs.add('relevant_after must be an ISO date or timestamp (e.g. "2026-07-06"); omit it for a follow-up with no proactive-ask date');
    }
    errs.throwIfAny();

    // RLS OFF: user_id stamped explicitly. source_thread_id is the
    // seeding conversation when there is one (chat dispatch and
    // reflection both carry a threadId; cross-thread agents pass null).
    const { data: row, error } = await ctx.adminClient
      .from('followups')
      .insert({
        user_id: ctx.userId,
        question,
        context,
        source_thread_id: ctx.threadId,
        relevant_after: relevantAfter,
      })
      .select('id, question, context, status, relevant_after, created_at')
      .single();
    if (error) throw new Error(`followup_create failed: ${error.message}`);
    return row;
  },
};

registerTool(followupCreate);
