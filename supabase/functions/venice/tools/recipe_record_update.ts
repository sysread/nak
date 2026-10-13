// recipe_record_update (function-side port)
//
// Patch a cooking record's date, content, tags, or outcome. Wire
// schema lives in src/lib/tools/recipe_record_update.schema.ts. RLS
// OFF: the update filters by user_id so a service-role write can only
// touch the caller's own records. The DB triggers stamp updated_at and
// null the embedding when date/content change.
//
// outcome is the one nullable patch field, so it carries THREE states
// through here: absent leaves the column alone, an explicit null
// clears the classification (and counts toward the at-least-one-of
// rule), a valid enum member sets it. The wire schema names the
// spurious-null hazard; this handler is what keeps the states distinct.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { ArgErrors } from './_validate.ts';
import {
  MAX_RECIPE_RECORD_CONTENT_CHARS,
  RECIPE_RECORD_COLUMNS,
  isRecipeRecordOutcome,
  normalizeRecipeRecordDate,
  normalizeRecipeRecordTags,
} from './_recipe_record_helpers.ts';

export const recipeRecordUpdate: ToolDef = {
  name: 'recipe_record_update',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const errs = new ArgErrors();
    if (!id) errs.add('id is required');

    const patch: Record<string, unknown> = {};
    if ('date' in args && args.date !== undefined && args.date !== null) {
      const { date, error } = normalizeRecipeRecordDate(args.date);
      if (error) errs.add(error);
      else if (date) patch.date = date;
    }
    if ('content' in args && args.content !== undefined && args.content !== null) {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content) errs.add('content cannot be empty');
      else if (content.length > MAX_RECIPE_RECORD_CONTENT_CHARS) {
        errs.add(
          `content exceeds ${MAX_RECIPE_RECORD_CONTENT_CHARS}-char limit (got ${content.length})`,
        );
      } else patch.content = content;
    }
    if ('tags' in args && args.tags !== undefined && args.tags !== null) {
      patch.tags = normalizeRecipeRecordTags(args.tags);
    }
    if ('outcome' in args && args.outcome !== undefined) {
      if (args.outcome === null) patch.outcome = null;
      else if (isRecipeRecordOutcome(args.outcome)) patch.outcome = args.outcome;
      else errs.add('outcome must be one of success, mixed, failure (or null to clear)');
    }
    if (Object.keys(patch).length === 0) {
      errs.add('nothing to update - pass at least one of date, content, tags, outcome');
    }
    errs.throwIfAny();

    const { data: row, error } = await ctx.adminClient
      .from('recipe_records')
      .update(patch)
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .select(RECIPE_RECORD_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`updateRecipeRecord failed: ${error.message}`);
    if (!row) throw new Error(`No record with id "${id}" found for this user.`);
    return row;
  },
};

registerTool(recipeRecordUpdate);
