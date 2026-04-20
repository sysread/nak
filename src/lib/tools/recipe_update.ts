/**
 * Patch an existing recipe's title, cooklang, source, or source_url.
 * Any field can be omitted to leave it alone. Explicit null for
 * `source` / `source_url` clears the field — useful when the model
 * wants to drop a stale URL.
 *
 * Mirrors recipe_save's cooklang cap — an update that breaches the
 * limit is rejected rather than truncated, so the model gets a clear
 * signal it needs to shrink the source.
 */
import type { ToolDef } from './types';
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../cooklang';
import { notifyCookbookChanged } from '../cookbook-store.svelte';

export const recipeUpdate: ToolDef = {
  name: 'recipe_update',
  description:
    'Update a recipe by id. Omit a field to leave it unchanged. Pass null for ' +
    '`source` or `source_url` to clear them. `cooklang` is capped at ' +
    `${MAX_RECIPE_COOKLANG_CHARS} chars. Use recipe_list first to find ids. ` +
    'Returns the updated row.',
  shortDescription: 'edit a saved recipe',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the recipe to update (from recipe_list).',
      },
      title: { type: 'string', minLength: 1, maxLength: MAX_RECIPE_TITLE_CHARS },
      cooklang: { type: 'string', minLength: 1, maxLength: MAX_RECIPE_COOKLANG_CHARS },
      source: {
        type: ['string', 'null'],
        maxLength: 400,
        description: 'Free-form provenance, or null to clear.',
      },
      source_url: {
        type: ['string', 'null'],
        maxLength: 2000,
        description: 'URL provenance, or null to clear.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const patch: {
      title?: string;
      cooklang?: string;
      source?: string | null;
      source_url?: string | null;
    } = {};
    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      const t = args.title.trim();
      if (t.length > MAX_RECIPE_TITLE_CHARS) {
        throw new Error(
          `title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit (got ${t.length})`
        );
      }
      patch.title = t;
    }
    if (typeof args.cooklang === 'string' && args.cooklang.length > 0) {
      if (args.cooklang.length > MAX_RECIPE_COOKLANG_CHARS) {
        throw new Error(
          `cooklang exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit (got ${args.cooklang.length})`
        );
      }
      patch.cooklang = args.cooklang;
    }
    if (args.source === null) patch.source = null;
    else if (typeof args.source === 'string') patch.source = args.source.trim();
    if (args.source_url === null) patch.source_url = null;
    else if (typeof args.source_url === 'string') patch.source_url = args.source_url.trim();
    if (Object.keys(patch).length === 0) {
      throw new Error(
        'provide at least one of title, cooklang, source, or source_url'
      );
    }
    const row = await ctx.supabase.updateRecipe(id, patch);
    notifyCookbookChanged();
    return row;
  },
};
