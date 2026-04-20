/**
 * Fetch the full Cooklang source for a single recipe by id. Used after
 * `recipe_list` once the model knows which recipe it wants to read,
 * edit, or transcribe for the user. Returns the whole row including
 * the (potentially multi-KiB) `cooklang` field.
 *
 * Returns `{found: false}` rather than throwing when the id is unknown
 * (or belongs to another user — RLS filters it out). Throwing would
 * force the LLM to guard every call with a try/catch; a structured
 * "not found" lets it handle the case in prose.
 */
import type { ToolDef } from './types';

export const recipeGet: ToolDef = {
  name: 'recipe_get',
  description:
    'Fetch a recipe by id. Returns {found: true, recipe: {id, title, ' +
    'source, source_url, cooklang, created_at, updated_at}} on hit, ' +
    'or {found: false} when the id is unknown. Use recipe_list first to ' +
    'discover ids.',
  shortDescription: 'fetch a recipe by id',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the recipe to fetch (from recipe_list).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const row = await ctx.supabase.getRecipe(id);
    if (!row) return { found: false };
    return { found: true, recipe: row };
  },
};
