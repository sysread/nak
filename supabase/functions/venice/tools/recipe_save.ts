// recipe_save (function-side port)
//
// Persist a new Cooklang recipe via recipe_create_with_version RPC
// (now p_user_id-aware - see schema delta). Returns the created row
// plus an empty photo array so the wire shape stays parallel with
// recipe_get / recipe_update.
//
// Cooklang authoring-quirk validator is inlined here (small, two
// regex checks). Mirrors validateCooklangSource in src/lib/cooklang.ts -
// if that file's check list grows, mirror the additions here.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { ArgErrors } from './_validate.ts';

const MAX_RECIPE_TITLE_CHARS = 200;
const MAX_RECIPE_COOKLANG_CHARS = 16_000;

// Mirror of validateCooklangSource in src/lib/cooklang.ts. Catches
// LLM-authoring quirks (backtick code spans, `@modifier @ingredient`
// patterns) BEFORE the row lands in the DB.
function validateCooklangSource(src: string): string[] {
  const errors: string[] = [];
  if (/`[^`\n]+`/.test(src)) {
    errors.push(
      'markdown code spans (`like this`) are not valid Cooklang and ' +
        'render as literal backticks. Remove the backticks; plain text ' +
        'in a step is already prose.',
    );
  }
  // `\??` after each `@` keeps the check effective when either token
  // also carries the optional-ingredient modifier (`@?`).
  const NAME = "[\\p{L}\\p{N}\\-_']+";
  const MODIFIER_PAIR_RE = new RegExp(`@\\??${NAME}[ \\t]+@\\??${NAME}\\{`, 'u');
  if (MODIFIER_PAIR_RE.test(src)) {
    errors.push(
      'detected `@modifier @ingredient{...}` pattern (e.g. `@pre-minced ' +
        '@garlic{1%tbsp}`). Write modifier + ingredient as a single ' +
        'multi-word name inside braces: `@pre-minced garlic{1%tbsp}`.',
    );
  }
  return errors;
}

export const recipeSave: ToolDef = {
  name: 'recipe_save',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
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
    const errs = new ArgErrors();
    let rating: number | null = null;
    if (typeof args.rating === 'number') {
      if (!Number.isInteger(args.rating) || args.rating < 1 || args.rating > 5) {
        errs.add('rating must be an integer between 1 and 5');
      } else {
        rating = args.rating;
      }
    }
    if (!title) errs.add('title is required');
    else if (title.length > MAX_RECIPE_TITLE_CHARS) {
      errs.add(`title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit (got ${title.length})`);
    }
    if (!cooklang) errs.add('cooklang is required');
    else if (cooklang.length > MAX_RECIPE_COOKLANG_CHARS) {
      errs.add(
        `cooklang exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit (got ${cooklang.length})`,
      );
    } else {
      // Syntax check only on a present, length-legal body - running it on an
      // oversize blob just stacks a second complaint about the same field.
      const cooklangErrors = validateCooklangSource(cooklang);
      if (cooklangErrors.length > 0) {
        errs.add(`cooklang validation failed:\n- ${cooklangErrors.join('\n- ')}`);
      }
    }
    errs.throwIfAny();
    // A save is always a recipe's first version, so an omitted
    // change_message defaults rather than erroring - there is no prior
    // state to describe a delta against, and the model routinely forgets
    // the field on a brand-new recipe. Matches the backfill seed naming
    // and the client-side recipe_save executor.
    const changeMessage =
      typeof args.change_message === 'string' && args.change_message.trim().length > 0
        ? args.change_message.trim()
        : 'Initial version';

    const { data, error } = await ctx.adminClient.rpc('recipe_create_with_version', {
      p_title: title,
      p_cooklang: cooklang,
      p_source: source,
      p_source_url: sourceUrl,
      p_rating: rating,
      p_image_ids: null,
      p_image_labels: null,
      p_change_message: changeMessage,
      p_user_id: ctx.userId,
    });
    if (error) throw new Error(`createRecipe failed: ${error.message}`);
    const rows = (data ?? []) as Array<{
      id: string;
      title: string;
      updated_at: string;
    }>;
    if (rows.length === 0) throw new Error('createRecipe returned no row');
    const row = rows[0]!;

    return {
      id: row.id,
      title: row.title,
      updated_at: row.updated_at,
      photos: [] as Array<{ id: string; position: number }>,
    };
  },
};

registerTool(recipeSave);
