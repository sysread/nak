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
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../cooklang';
// Import from the plain-.ts sibling, not cookbook-store.svelte.ts —
// this tool gets bundled into the reflection Web Worker via the
// tool registry, and pulling a rune-using module in would crash the
// worker with `$state is not defined` at load time.
import { notifyCookbookChanged } from '../cookbook-events';

export const recipeSave: ToolDef = {
  name: 'recipe_save',
  description:
    "Save a new recipe to the user's cookbook. `cooklang` is the raw " +
    'Cooklang source (https://cooklang.org/docs/spec/): @ingredient{qty%unit}, ' +
    `#cookware{}, ~timer{d%unit}, >> metadata: value. Max ${MAX_RECIPE_COOKLANG_CHARS} ` +
    'chars. Group long recipes with `== Section Name ==` or `# Section Name` ' +
    'headers. Two authoring styles are supported and can be mixed: (a) pure ' +
    'Cooklang, where every line is an instruction with inline ingredient ' +
    'references; (b) cookbook-style, where a line whose first non-whitespace ' +
    'character is `@` is an ingredient DECLARATION (contributes to the ' +
    'ingredients list but is NOT numbered as an instruction), followed by a ' +
    'dash-only line (e.g. `--` on its own) that ends the declaration block ' +
    'and resets the section so the prose instructions below render as a flat ' +
    'numbered list. Wrap a long instruction across lines by prefixing ' +
    'continuation lines with `> ` (merged into the previous step). `source` ' +
    'is an optional free-form provenance string; `source_url` is the URL if ' +
    'the recipe was imported from the web. Returns the created ' +
    '{id, title, updated_at}.',
  shortDescription: 'save a recipe to the cookbook',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_TITLE_CHARS,
        description: 'Short display name for the recipe.',
      },
      cooklang: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_COOKLANG_CHARS,
        description: 'Full Cooklang source for the recipe.',
      },
      source: {
        type: 'string',
        maxLength: 400,
        description:
          'Optional free-form provenance (e.g. "NYT Cooking — Alison Roman"). ' +
          'Omit when not applicable.',
      },
      source_url: {
        type: 'string',
        maxLength: 2000,
        description: 'Optional URL the recipe was imported from.',
      },
    },
    required: ['title', 'cooklang'],
    additionalProperties: false,
  },
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
    if (title.length > MAX_RECIPE_TITLE_CHARS) {
      throw new Error(
        `title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit (got ${title.length})`
      );
    }
    const row = await ctx.supabase.createRecipe(title, cooklang, source, sourceUrl);
    notifyCookbookChanged();
    return { id: row.id, title: row.title, updated_at: row.updated_at };
  },
};
