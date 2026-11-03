/**
 * Schema-only export for `recipes` - the recipe combination tool. One
 * tool, one `op` enum discriminator (list / get / save / delete) with
 * flat per-op parameters, replacing the four recipe_list / recipe_get /
 * recipe_save / recipe_delete verb tools. The combo form follows the
 * `skills` precedent (see that schema's header for the calibration
 * record and the enum-vs-oneOf rationale); per-op required fields
 * cannot be expressed in one flat JSON Schema, so the edge impl routes
 * validation on `op` with ArgErrors
 * (supabase/functions/venice/tools/recipes.ts).
 *
 * The save op carries the full Cooklang authoring spec. The spec lives
 * in the `cooklang` parameter's description - it is needed exactly when
 * writing Cooklang, and keeping it there keeps the combo's routing
 * description scannable. The spec text is load-bearing (cooklang is
 * underrepresented in model training data); every guard survives the
 * merge verbatim.
 *
 * Coupling: src/lib/ui/generated-image.ts is unrelated here, but the
 * recipe_photos combination tool (see that schema) is the sibling
 * surface - save never touches photos, by contract.
 */

import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../recipe-limits';

/** Re-exports from the list op's original schema module constants. */
export const RECIPE_LIST_DEFAULT_LIMIT = 100;
export const RECIPE_LIST_MAX_LIMIT = 500;

function formatRecipesArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of recipe
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  if (typeof args.id === 'string' && args.id) {
    lines.push(`**Recipe id:** ${args.id}`);
  }
  for (const key of ['title', 'source', 'source_url', 'change_message', 'query', 'sort', 'limit'] as const) {
    const v = args[key];
    if (v === undefined || v === null || v === '') continue;
    if (key === 'source_url' && typeof v === 'string') {
      lines.push(`**source_url:** <${v}>`);
    } else {
      lines.push(`**${key}:** ${String(v)}`);
    }
  }
  if (typeof args.cooklang === 'string' && args.cooklang.length > 0) {
    lines.push('');
    lines.push('**cooklang:**');
    lines.push('');
    lines.push('```');
    lines.push(args.cooklang);
    lines.push('```');
  }
  return lines.join('\n');
}

export const recipesSchema = {
  name: 'recipes',
  description:
    "Read, save, and remove the user's cookbook recipes. One tool, " +
    'one op. list: browse titles (optional case-insensitive title ' +
    'substring, limit, sort). get: one recipe full row by id - ' +
    'Cooklang source + current photo list. save: create a new ' +
    'recipe (title + cooklang required), or update by id passing ' +
    'only the fields that change (pass null for source / ' +
    'source_url to clear); the save is REFUSED with a list of ' +
    'problems when the Cooklang breaks the grammar - fix them and ' +
    'resubmit. The star rating is the user\'s own verdict and is ' +
    'NOT editable here - only they can set or clear it, from the ' +
    'recipe card; save never touches photos (the recipe_photos ' +
    'tool owns those - its result reports the current set). ' +
    'delete: hard-remove by id; reports honestly when nothing ' +
    'matched. On save, change_message is optional on create ' +
    '(defaults to "Initial version") and required on update - it ' +
    'lands in the history the user reviews.',
  shortDescription: 'read, save, and remove cookbook recipes',
  formatArgs: formatRecipesArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'get', 'save', 'delete'],
        description:
          'REQUIRED on every call. The operation to run. list: ' +
          'browse titles. get: one full recipe by id. save: create ' +
          'or update. delete: hard-remove by id.',
      },
      id: {
        type: 'string',
        description:
          'Recipe UUID (from list). get: the recipe to fetch ' +
          '(required). save: the recipe to update (omit to create). ' +
          'delete: the recipe to remove (required).',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_TITLE_CHARS,
        description:
          'save only. Short display name; required to create. ' +
          'Titles are unique per user - a create whose title ' +
          'exactly matches an existing recipe routes to that ' +
          "recipe's update instead of duplicating.",
      },
      cooklang: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_COOKLANG_CHARS,
        description:
          'save only. Full Cooklang source (max ' +
          `${MAX_RECIPE_COOKLANG_CHARS} chars); required to create` +
          ', optional on update (omit to leave the body unchanged). ' +
          'Grammar per line: ' +
          'step | ingredient-declaration | section | metadata | comment; ' +
          'ingredient := "@" "?"? name ("{" qty "%" unit? "}")?; ' +
          'cookware := "#" name "{}"; ' +
          'timer := "~" name? "{" qty "%" unit "}" ' +
          `(e.g. ~{4%hours}); metadata := ">>" key ":" value. ` +
          'Two authoring styles, mixable. Pure style puts references inline ' +
          'in step prose ("Season the @pork{}, add @soy sauce{2%tbsp} to the ' +
          '#wok{}, cook ~{3%minutes}"). Cookbook style: `@`-first lines are ' +
          'not numbered as steps); a dash-only line ends the declaration block so ' +
          'prose below renders as a flat numbered list. Guards: ' +
          'a modifier+ingredient is ONE multi-word braced name - ' +
          '`@pre-minced garlic{1%tbsp}`, NEVER `@pre-minced @garlic{...}`; ' +
          'prep hints are a note AFTER the reference, not inside the name - ' +
          '`@basil{1%tbsp} (finely chopped)`, never `@finely chopped basil{...}`; ' +
          'optional ingredients take `?` after the `@` (`@?cilantro{2%tbsp}`); ' +
          'alternatives get one `@` with the substitute as prose; ' +
          'prefer timer syntax `~{N%unit}` over prose durations (it feeds the timers list); ' +
          "a `> `-prefixed line continues the previous step and keeps its own line: " +
          'bullet continuations (`- `/`* `) render as a sub-list inside the step, ' +
          'plain ones rejoin the step prose; ' +
          '`== Soup ==` / `# Soup` start sections (`=== Base ===` for a ' +
          'sub-section; `## Soup` is NOT a heading). A heading is never a ' +
          'comment, note, or callout: a section with no lines under it is ' +
          'dropped from the rendered recipe, so write a note for the cook as ' +
          'a plain step line (e.g. `**Note:** at altitude, add 20 minutes`); ' +
          '`--` starts a hidden comment, so write ranges with one hyphen ' +
          '(`20-25 minutes`); ' +
          'braces belong only to an `@`/`#`/`~` reference and carry exactly ' +
          'one `%` (`~{12-15%min}`, never `~{12-15 min}` or `{1/2%1%tsp}`) - ' +
          'plain values like temperatures take no braces (`325°F`, not ' +
          '`{325°F}`); ' +
          'emphasis `**bold**` / `*italic*` renders, backticks do NOT.',
      },
      source: {
        type: ['string', 'null'],
        maxLength: 400,
        description:
          'save only. Optional free-form provenance (e.g. "NYT ' +
          'Cooking - Alison Roman"), or null to clear.',
      },
      source_url: {
        type: ['string', 'null'],
        maxLength: 2000,
        description: 'save only. Optional URL provenance, or null to clear.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'save only. One-line history note; lands in the recipe ' +
          'changelog the user reviews. Required when updating; ' +
          'optional on create (defaults to "Initial version").',
      },
      query: {
        type: 'string',
        description:
          'list only. Optional case-insensitive substring filter on title.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: RECIPE_LIST_MAX_LIMIT,
        description: `list only. Max results (default ${RECIPE_LIST_DEFAULT_LIMIT}, max ${RECIPE_LIST_MAX_LIMIT}).`,
      },
      sort: {
        type: 'string',
        enum: ['updated', 'rating'],
        description:
          "list only. 'updated' (default) most-recently-edited " +
          "first; 'rating' highest-rated first, unrated last.",
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
} as const;
