// recipe_record_delete (function-side port)
//
// Hard-delete one cooking record. Wire schema lives in
// src/lib/tools/recipe_record_delete.schema.ts. RLS OFF: the delete
// filters by user_id so a service-role call can only remove the
// caller's own records. Returns {deleted: false} for an
// unknown/non-owned id rather than throwing, so a probing caller can't
// distinguish miss from not-owned.
//
// No changelog append, unlike the wiki twin's record_delete: records
// are themselves the diary (the recipe-records plan carries no
// recipe_changelog), so there is no parent audit surface to append to.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

export const recipeRecordDelete: ToolDef = {
  name: 'recipe_record_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    const { data, error } = await ctx.adminClient
      .from('recipe_records')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .select('id');
    if (error) throw new Error(`deleteRecipeRecord failed: ${error.message}`);
    const deleted = Array.isArray(data) && data.length > 0;
    if (!deleted) {
      return {
        deleted,
        reason: 'No cooking record with that id - already deleted, never existed, or not yours.',
      };
    }
    return { deleted };
  },
};

registerTool(recipeRecordDelete);
