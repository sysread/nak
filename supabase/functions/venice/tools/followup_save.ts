// followup_save (create/update-merged follow-up write)
//
// One tool behind an optional `id`: omit it to create a pending
// question ("Ask how the lasagna turned out"), pass it to revise or
// reschedule an open follow-up. Consolidates the former
// followup_create + followup_update. Wire schema lives in
// src/lib/tools/followup_save.schema.ts; the reflection agent carries
// its own wire copy. Caps come from _shared/followups.ts. Auth:
// b-strict. See docs/dev/followups.md.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  MAX_FOLLOWUP_CONTEXT_CHARS,
  MAX_FOLLOWUP_QUESTION_CHARS,
} from '../../_shared/followups.ts';
import { ArgErrors } from './_validate.ts';

/**
 * Parse the model-supplied relevant_after into an ISO timestamptz.
 * Accepts a date ("2026-07-06") or a full timestamp. A bare date parses
 * as UTC midnight - close enough for "some time after that day", which
 * is all proactive relevance needs. Returns null for absent, a string
 * for valid, undefined for unparseable (caller records the error).
 * Exported for the followup-gather tests.
 */
export function parseRelevantAfter(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const t = Date.parse(value.trim());
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

async function doCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const question = (args.question as string).trim();
  const context = typeof args.context === 'string' ? args.context.trim() : '';

  const errs = new ArgErrors();
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
  if (error) throw new Error(`followup_save (create) failed: ${error.message}`);
  return row;
}

async function doUpdate(
  id: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const errs = new ArgErrors();

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
  if (error) throw new Error(`followup_save (revise) failed: ${error.message}`);
  if (!row) {
    throw new Error(
      'followup not found or not open - only open follow-ups can be revised (use followup_list to check status)',
    );
  }
  return row;
}

export const followupSave = {
  name: 'followup_save',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id =
      typeof args.id === 'string' && args.id.trim().length > 0
        ? args.id.trim()
        : undefined;

    // Shared pre-route validation: field caps and date parseability.
    const errs = new ArgErrors();
    if (typeof args.question === 'string') {
      const question = args.question.trim();
      if (question.length > MAX_FOLLOWUP_QUESTION_CHARS) {
        errs.add(
          `question exceeds ${MAX_FOLLOWUP_QUESTION_CHARS}-char limit (got ${question.length})`,
        );
      }
    }
    if (
      typeof args.context === 'string' &&
      args.context.length > MAX_FOLLOWUP_CONTEXT_CHARS
    ) {
      errs.add(
        `context exceeds ${MAX_FOLLOWUP_CONTEXT_CHARS}-char limit (got ${args.context.length})`,
      );
    }
    if (args.relevant_after !== undefined && args.relevant_after !== null) {
      if (typeof args.relevant_after !== 'string' || parseRelevantAfter(args.relevant_after) === undefined) {
        errs.add('relevant_after must be an ISO date or timestamp (e.g. "2026-07-06")');
      }
    }
    errs.throwIfAny();

    if (id) return doUpdate(id, args, ctx);

    // Create form: question is the only required field.
    if (
      typeof args.question !== 'string' ||
      args.question.trim().length === 0
    ) {
      throw new Error('missing required field for creating: question');
    }
    return doCreate(args, ctx);
  },
};

registerTool(followupSave);
