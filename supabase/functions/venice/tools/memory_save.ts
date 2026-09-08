// memory_save (create/update-merged memory write)
//
// One tool behind an optional `id`: omit it to create a new memory,
// pass it to patch label/data/confidence. Consolidates the former
// memory_create + memory_update. Wire schema lives in
// src/lib/tools/memory_save.schema.ts; the reflection agent carries
// its own wire copy of the same shape. Auth: b-strict.
//
// The echoed update row deliberately omits `topics`. A label/data
// change fires clear_memory_topics_on_change, which empties the column
// so the memory-topics curation unit re-tags the row, and the
// RETURNING clause reads the row back AFTER that trigger - so the
// field would read as an empty list precisely when the model had just
// edited the text. Reporting it invites "your tags are gone" on a
// write that lost nothing. memory_search and memory_get are the
// read-back paths once the unit has caught up.
//
// There is no natural-key dedup heuristic here (unlike wiki_save):
// memories have no unique constraint - label is a handle, not an
// identity. A duplicate save is cleaned up by the librarian's
// consolidation pass.

import { registerTool, type ToolContext } from '../performToolCall.ts';
import { appendMemoryChangelog } from './_memory_changelog.ts';
import { MAX_MEMORY_DATA_CHARS } from './_memory_data_budget.ts';
import {
  memoryDataBudgetError,
  readMemoryDataLengths,
} from './_memory_data_budget.ts';
import { ArgErrors, requireFiniteNumber } from './_validate.ts';

// Mirror of MAX_MEMORY_CHANGELOG_MESSAGE_CHARS in src/lib/memories.ts.
// The data cap is single-sourced from _memory_data_budget.ts, which owns
// the length rule the rewrite paths share.
const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;

async function doCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const label = (args.label as string).trim();
  const data = args.data as string;
  const message = typeof args.message === 'string' ? args.message.trim() : '';

  const errs = new ArgErrors();
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
}

async function doUpdate(
  id: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const message = typeof args.message === 'string' ? args.message.trim() : '';

  const errs = new ArgErrors();
  // The changelog message is optional: when the model omits it we
  // synthesize one from the row's label so an edit never blocks on it.
  // Models were observed omitting message (or inventing param names to
  // carry it) and round-tripping the rejection; defaulting removes the
  // field as a failure surface, mirroring the create path.
  if (message.length > MAX_MEMORY_CHANGELOG_MESSAGE_CHARS) {
    errs.add(
      `message exceeds ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
    );
  }

  // One read serves two consumers: the non-growth budget below and the
  // changelog's before-size. Empty when the row is unreadable, which
  // degrades the budget to the flat ceiling and the changelog to an
  // unknown before-size.
  const priorLengths = await readMemoryDataLengths(ctx.adminClient, ctx.userId, [id]);

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
  // Direct confidence set, same [1.0, 10.0] contract as the create
  // path's initial confidence. The graded levers (memory_reaffirm +0.5,
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
    .select('id, label, data, confidence, created_at, updated_at')
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
}

export const memorySave = {
  name: 'memory_save',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id =
      typeof args.id === 'string' && args.id.trim().length > 0
        ? args.id.trim()
        : undefined;

    // Pre-route validation shared by both forms: the flat data ceiling
    // and the confidence scale. The conditional field requirements
    // (create-set vs at-least-one-changeable) are enforced inside the
    // respective halves, which own their field semantics.
    const errs = new ArgErrors();
    if (
      typeof args.data === 'string' &&
      args.data.length > MAX_MEMORY_DATA_CHARS
    ) {
      errs.add(
        `data exceeds ${MAX_MEMORY_DATA_CHARS}-char limit (got ${args.data.length}); split across multiple memories`,
      );
    }
    if (args.confidence !== undefined && args.confidence !== null) {
      const coerced = requireFiniteNumber(errs, 'confidence', args.confidence);
      if (coerced !== null && (coerced < 1.0 || coerced > 10.0)) {
        errs.add(
          `confidence must be in [1.0, 10.0] (got ${coerced}); ` +
            'it is a decimal on a 1-10 scale, not a 0-1 probability',
        );
      }
    }
    errs.throwIfAny();

    if (id) return doUpdate(id, args, ctx);
    // Create-side required check: label + data (the router's shared
    // check lives in defineUpsertTool, but this impl hand-rolls the
    // split for its per-resource validation).
    const missing: string[] = [];
    if (
      typeof args.label !== 'string' ||
      args.label.trim().length === 0
    ) {
      missing.push('label');
    }
    if (
      typeof args.data !== 'string' ||
      args.data.length === 0
    ) {
      missing.push('data');
    }
    if (missing.length > 0) {
      throw new Error(
        `missing required field${missing.length > 1 ? 's' : ''} for creating: ${missing.join(', ')}`,
      );
    }
    return doCreate(args, ctx);
  },
};

registerTool(memorySave);
