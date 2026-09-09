/**
 * Schema-only export for recipe_save - the create/update-merged recipe
 * write (the routing contract is the same id-optional upsert shape as
 * wiki_save; there is no shared runtime module because each resource's
 * conditional validation differs - see supabase/functions/venice/
 * tools/recipe_save.ts). Impl lives in the edge function, which also
 * self-registers the tool for dispatch.
 *
 * Carries a `formatArgs` override read by the tool-call detail
 * panel (src/components/ToolCalls.svelte via src/lib/ui/tool-calls.ts).
 * The generic JSON-as-markdown formatter would render the cooklang
 * source as a fenced block automatically because it contains newlines,
 * but the surrounding shape (a top-level bullet for every other field
 * with cooklang buried among them) reads worse than promoting the
 * cooklang block to a labelled section below the metadata. The
 * override orders the fields the way a reader would scan them -
 * activity, id, title, source, change_message, then the recipe body
 * itself.
 *
 * The full Cooklang authoring spec lives verbatim in this
 * description (cooklang is poorly represented in model training
 * data). Both forms of the tool need it, and under
 * every-tool-declared-every-request there is exactly one schema on
 * the wire for it.
 */
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../recipe-limits';

function formatRecipeSaveArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  const scalar: Array<[string, string]> = [];
  if (typeof args.id === 'string' && args.id) {
    scalar.push(['id', String(args.id)]);
  }
  for (const key of ['title', 'source', 'source_url', 'change_message'] as const) {
    const v = args[key];
    if (v === undefined || v === null || v === '') continue;
    if (key === 'source_url' && typeof v === 'string') {
      scalar.push([key, '<' + v + '>']);
    } else {
      scalar.push([key, String(v)]);
    }
  }
  if (typeof args.activity === 'string' && args.activity.trim().length > 0) {
    lines.push('> ' + args.activity.trim());
    lines.push('');
  }
  for (const [k, v] of scalar) {
    lines.push('- **' + k + ':** ' + v);
  }
  if (typeof args.cooklang === 'string' && args.cooklang.length > 0) {
    if (scalar.length > 0) lines.push('');
    lines.push('**cooklang:**');
    lines.push('');
    lines.push('```');
    lines.push(args.cooklang);
    lines.push('```');
  }
  return lines.join('\n');
}

export const recipeSaveSchema = {
  name: 'recipe_save',
  description:
    "Save a recipe: create a new one, or update an existing one by id. " +
    'Omit id to create (title + cooklang required); pass id (from ' +
    'recipe_list) to update, providing only the fields that change - ' +
    'pass null for source / source_url to clear them. cooklang is the ' +
    `raw recipe source (max ${MAX_RECIPE_COOKLANG_CHARS} chars). ` +
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
    "wrap long steps with a `> ` continuation line; " +
    '`== Soup ==` / `# Soup` start sections; ' +
    'emphasis `**bold**` / `*italic*` renders, backticks do NOT. ' +
    "The star rating is the user's verdict and is not editable here - " +
    'only they can set or clear it, from the recipe card. ' +
    'change_message: optional on create (defaults to "Initial version"), ' +
    'required on update - it lands in the recipe history the user reviews. ' +
    'Returns the saved row plus the current photo list, which this tool ' +
    'never changes - use the recipe_photos_* tools to edit photos.',
  shortDescription: 'save a recipe to the cookbook',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'UUID of the recipe to update (from recipe_list). Omit to ' +
          'create a new recipe.',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_TITLE_CHARS,
        description: 'Short display name.',
      },
      cooklang: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_COOKLANG_CHARS,
        description: 'Full Cooklang source.',
      },
      source: {
        type: ['string', 'null'],
        maxLength: 400,
        description:
          'Optional free-form provenance (e.g. "NYT Cooking - Alison ' +
          'Roman"), or null to clear.',
      },
      source_url: {
        type: ['string', 'null'],
        maxLength: 2000,
        description: 'Optional URL provenance, or null to clear.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line history note; lands in the recipe changelog the ' +
          'user reviews. Required when updating; optional on create ' +
          '(defaults to "Initial version").',
      },
    },
    required: ['title', 'cooklang'],
    additionalProperties: false,
  },
  formatArgs: formatRecipeSaveArgs,
} as const;
