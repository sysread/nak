// followups (function-side combination tool)
//
// One tool behind an `op` enum discriminator: list / save / close /
// dismiss over the user's pending questions. Replaces the four
// followup_* verb registrations; the per-op bodies survive verbatim
// as internal functions - only the envelope changed (see the browser
// schema's header).
//
// Auth: b-strict throughout. followups has user_id directly, so every
// read filters .eq('user_id', userId) and every write stamps it.
//
// The status='open' guard on close/dismiss/revise is the load-bearing
// filter: a double-close reads as not-found rather than silently
// rewriting an already-recorded resolution, and a closed loop is
// history - re-forming the question is a create.
//
// The reschedule ledger: a relevant_after change resets
// last_surfaced_at + surface_count (the moved plan has not been
// nagged about yet); a question/context-only reword keeps the
// ledger.
//
// Per-op required fields (id + resolution on close, id on
// dismiss/revise, question on create) are enforced inside the per-op
// bodies below - the flat wire schema cannot express them. Error
// strings are load-bearing: substring test assertions pin them
// (tests/followups_tools.test.ts).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  MAX_FOLLOWUP_CONTEXT_CHARS,
  MAX_FOLLOWUP_QUESTION_CHARS,
  MAX_FOLLOWUP_RESOLUTION_CHARS,
} from '../../_shared/followups.ts';
import { ArgErrors } from './_validate.ts';

// Open loops are few by design; closed history is windowed so the dedup
// evidence stays current without the result growing unbounded.
const OPEN_LIST_CAP = 50;
const CLOSED_LIST_CAP = 20;

/**
 * Parse the model-supplied relevant_after into an ISO timestamptz.
 * Accepts a date ("2026-07-06") or a full timestamp. A bare date parses
 * as UTC midnight - close enough for "some time after that day", which
 * is all proactive relevance needs. Returns null for absent, a string
 * for valid, undefined for unparseable (caller records the error).
 */
function parseRelevantAfter(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const t = Date.parse(value.trim());
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listOp(_args: Record<string, unknown>, ctx: ToolContext) {
  // RLS OFF: filter by userId on both reads.
  const openPromise = ctx.adminClient
    .from('followups')
    .select('id, question, context, status, relevant_after, surface_count, created_at')
    .eq('user_id', ctx.userId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(OPEN_LIST_CAP);
  const closedPromise = ctx.adminClient
    .from('followups')
    .select('id, question, status, resolution, updated_at')
    .eq('user_id', ctx.userId)
    .in('status', ['answered', 'dismissed', 'expired'])
    .order('updated_at', { ascending: false })
    .limit(CLOSED_LIST_CAP);

  const [openRes, closedRes] = await Promise.all([openPromise, closedPromise]);
  if (openRes.error) throw new Error(`followups op=list failed: ${openRes.error.message}`);
  if (closedRes.error) throw new Error(`followups op=list failed: ${closedRes.error.message}`);
  return {
    open: openRes.data ?? [],
    recently_closed: closedRes.data ?? [],
  };
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

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
  if (error) throw new Error(`followups op=save (create) failed: ${error.message}`);
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
  if (error) throw new Error(`followups op=save (revise) failed: ${error.message}`);
  if (!row) {
    throw new Error(
      'followup not found or not open - only open follow-ups can be revised (use followups op=list to check status)',
    );
  }
  return row;
}

async function saveOp(args: Record<string, unknown>, ctx: ToolContext) {
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
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

async function closeOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const resolution = typeof args.resolution === 'string' ? args.resolution.trim() : '';

  const errs = new ArgErrors();
  if (!id) errs.add('id is required (from followups op=list)');
  if (!resolution) errs.add('resolution is required - one line on what the answer was');
  else if (resolution.length > MAX_FOLLOWUP_RESOLUTION_CHARS) {
    errs.add(
      `resolution exceeds ${MAX_FOLLOWUP_RESOLUTION_CHARS}-char limit (got ${resolution.length})`,
    );
  }
  errs.throwIfAny();

  // RLS OFF: filter by userId. The status='open' guard makes a
  // double-close read as not-found rather than silently rewriting an
  // already-recorded resolution.
  const { data: row, error } = await ctx.adminClient
    .from('followups')
    .update({
      status: 'answered',
      resolution,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .eq('status', 'open')
    .select('id, question, status, resolution')
    .maybeSingle();
  if (error) throw new Error(`followups op=close failed: ${error.message}`);
  if (!row) {
    throw new Error(
      'followup not found or already closed (use followups op=list to check status)',
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// dismiss
// ---------------------------------------------------------------------------

async function dismissOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const errs = new ArgErrors();
  if (!id) errs.add('id is required (from followups op=list)');
  errs.throwIfAny();

  // RLS OFF: filter by userId. Only open loops are dismissable.
  const { data: row, error } = await ctx.adminClient
    .from('followups')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .eq('status', 'open')
    .select('id, question, status')
    .maybeSingle();
  if (error) throw new Error(`followups op=dismiss failed: ${error.message}`);
  if (!row) {
    throw new Error(
      'followup not found or not open (use followups op=list to check status)',
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// combination-tool envelope
// ---------------------------------------------------------------------------

export const followups: ToolDef = {
  name: 'followups',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const op = typeof args.op === 'string' ? args.op.trim() : '';
    if (!op) {
      throw new Error('op is required (list | save | close | dismiss)');
    }
    switch (op) {
      case 'list':
        return listOp(args, ctx);
      case 'save':
        return saveOp(args, ctx);
      case 'close':
        return closeOp(args, ctx);
      case 'dismiss':
        return dismissOp(args, ctx);
      default:
        throw new Error(
          `unknown op "${op}" - expected list, save, close, or dismiss`,
        );
    }
  },
};

registerTool(followups);
