/**
 * Save a new Cooklang recipe for the user. Returns the created row so
 * the LLM can cite its id in a follow-up update/delete without a
 * second lookup.
 *
 * `cooklang` must be a plain-text Cooklang source string — the model is
 * expected to have already converted whatever it scraped (schema.org
 * JSON-LD, prose, etc.) into the `@ingredient{qty%unit}` / `#cookware` /
 * `~timer{d%unit}` grammar. Storing parsed HTML here would defeat the
 * whole point of using Cooklang as the source of truth.
 */
import type { ToolDef } from './types';
import {
  MAX_RECIPE_COOKLANG_CHARS,
  MAX_RECIPE_TITLE_CHARS,
  validateCooklangSource,
} from '../cooklang';
// Import from the plain-.ts sibling, not cookbook-store.svelte.ts —
// this tool gets bundled into the reflection Web Worker via the
// tool registry, and pulling a rune-using module in would crash the
// worker with `$state is not defined` at load time.
import { notifyCookbookChanged } from '../cookbook-events';
import { recipeSaveSchema } from './recipe_save.schema';

export const recipeSave: ToolDef = {
  ...recipeSaveSchema,
  async execute(args, ctx) {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const cooklang = typeof args.cooklang === 'string' ? args.cooklang : '';
    const source =
      typeof args.source === 'string' && args.source.trim().length > 0
        ? args.source.trim()
        : null;
    const sourceUrl =
      typeof args.source_url === 'string' && args.source_url.trim().length > 0
        ? args.source_url.trim()
        : null;
    let rating: number | null = null;
    if (typeof args.rating === 'number') {
      if (!Number.isInteger(args.rating) || args.rating < 1 || args.rating > 5) {
        throw new Error('rating must be an integer between 1 and 5');
      }
      rating = args.rating;
    }
    if (!title) throw new Error('title is required');
    if (!cooklang) throw new Error('cooklang is required');
    // Guard on length — the model may ignore the schema's maxLength.
    // Rejecting (rather than truncating) gives it an error it can act
    // on: trim prose, not silently store a half-saved recipe.
    if (cooklang.length > MAX_RECIPE_COOKLANG_CHARS) {
      throw new Error(
        `cooklang exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit (got ${cooklang.length}); trim prose or split into multiple recipes`
      );
    }
    // Catch LLM-authoring quirks (markdown emphasis, `@modifier
    // @ingredient` pattern) BEFORE the row lands in the DB. Failing at
    // the tool surface gives the LLM a corrective error it can act on;
    // silently storing source that renders wrong wastes the user's
    // attention later.
    const cooklangErrors = validateCooklangSource(cooklang);
    if (cooklangErrors.length > 0) {
      throw new Error(`cooklang validation failed:\n- ${cooklangErrors.join('\n- ')}`);
    }
    if (title.length > MAX_RECIPE_TITLE_CHARS) {
      throw new Error(
        `title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit (got ${title.length})`
      );
    }
    const changeMessage =
      typeof args.change_message === 'string' ? args.change_message.trim() : '';
    if (!changeMessage) {
      throw new Error('change_message is required');
    }
    const row = await ctx.supabase.createRecipe(
      title,
      cooklang,
      source,
      sourceUrl,
      rating,
      changeMessage
    );
    notifyCookbookChanged();
    // Echo the (always-empty for a brand-new recipe) photo set so the
    // return shape stays parallel with recipe_update / recipe_get -
    // the LLM doesn't have to special-case "did this tool give me
    // photos or not?".
    return {
      id: row.id,
      title: row.title,
      updated_at: row.updated_at,
      photos: [] as Array<{ id: string; position: number }>,
    };
  },
};
