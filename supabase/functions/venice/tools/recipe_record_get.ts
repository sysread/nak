// recipe_record_get (function-side port)
//
// Fetch one cooking record's full body by id. Returns {found: false}
// for unknown or non-owned ids (the user_id filter drops other users'
// rows). Wire schema lives in src/lib/tools/recipe_record_get.schema.ts.
//
// The merge guard's read side: recipe_record_update's prompt tells the
// model to get the record first and pass the merged body, because
// content is a full-replacement patch.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { RECIPE_RECORD_COLUMNS } from './_recipe_record_helpers.ts';

export const recipeRecordGet: ToolDef = {
  name: 'recipe_record_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId, then id, so miss vs not-owned are
    // indistinguishable to a probing caller.
    const { data, error } = await ctx.adminClient
      .from('recipe_records')
      .select(RECIPE_RECORD_COLUMNS)
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`getRecipeRecord failed: ${error.message}`);
    if (!data) return { found: false };
    return { found: true, record: data };
  },
};

registerTool(recipeRecordGet);
