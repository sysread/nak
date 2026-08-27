/**
 * Schema-only export for recipe_save. Impl lives in `./recipe_save`.
 *
 * Carries a `formatArgs` override read by the tool-call detail
 * panel (`src/components/ToolCalls.svelte` via
 * `src/lib/ui/tool-calls.ts`). The generic JSON-as-markdown
 * formatter would render the cooklang source as a fenced block
 * automatically because it contains newlines, but the surrounding
 * shape (a top-level bullet for every other field with cooklang
 * buried among them) reads worse than promoting the cooklang
 * block to a labelled section below the metadata. The override
 * orders the fields the way a reader would scan them - activity,
 * title, source, change_message, then the recipe body
 * itself.
 */
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../recipe-limits';

function formatRecipeSaveArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  const scalar: Array<[string, string]> = [];
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
    "Save a new recipe. cooklang is the raw Cooklang source " +
    '(https://cooklang.org/docs/spec/): @ingredient{qty%unit}, ' +
    `#cookware{}, ~timer{d%unit}, >> metadata: value (max ${MAX_RECIPE_COOKLANG_CHARS} ` +
    'chars). Group long recipes with `== Section ==` or `# Section` ' +
    'headers. Two authoring styles supported and mixable: (a) pure ' +
    'Cooklang (each line is an instruction with inline ingredients); ' +
    "(b) cookbook-style (a line whose first non-whitespace char is `@` " +
    'is an ingredient DECLARATION, not numbered as an instruction; a ' +
    'dash-only line like `--` ends the declaration block so prose ' +
    'instructions below render as a flat numbered list). Wrap a long ' +
    'instruction across lines by prefixing continuations with `> `. ' +
    'Inline emphasis is supported in step text: `**bold**`, ' +
    '`*italic*`, and `_italic_` render as styled spans. Backtick code ' +
    'spans are NOT rendered - they show as literal backticks, so ' +
    "don't use them. For durations, prefer the Cooklang timer syntax " +
    '`~{N%unit}` (e.g. `~{4-5%hours}`) so the duration also ' +
    'contributes to the timers list; wrapping it in `**...**` for ' +
    'emphasis is fine but the `~` is what makes it a timer. For an ' +
    'ingredient with a modifier, write the whole phrase as a single ' +
    'multi-word braced name: `@pre-minced garlic{1%tbsp}`, NEVER ' +
    '`@pre-minced @garlic{1%tbsp}` (which creates two separate ' +
    'ingredient entries). Mark an OPTIONAL ingredient with `?` right ' +
    'after the `@` (`@?cilantro{2%tbsp}`, bare `@?cilantro`) - it ' +
    'renders with an "(optional)" tag in the ingredient list. For ' +
    'alternatives ("use X or Y"), only the ' +
    'primary ingredient gets `@`; write the substitute as plain prose. ' +
    'change_message lands in the recipe history; it is optional here ' +
    'and defaults to "Initial version" since a save is always the ' +
    'first version. Returns {id, title, updated_at}.',
  shortDescription: 'save a recipe to the cookbook',
  parameters: {
    type: 'object',
    properties: {
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
        type: 'string',
        maxLength: 400,
        description:
          'Optional free-form provenance (e.g. "NYT Cooking - Alison Roman").',
      },
      source_url: {
        type: 'string',
        maxLength: 2000,
        description: 'Optional URL the recipe was imported from.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'Optional one-line history note; lands in the recipe changelog ' +
          'the user reviews. Defaults to "Initial ' +
          'version" when omitted - only set it when you have something ' +
          'more specific than "first save" to record (e.g. "Imported ' +
          'from NYT Cooking", "Captured from prose the user pasted").',
      },
    },
    required: ['title', 'cooklang'],
    additionalProperties: false,
  },
  formatArgs: formatRecipeSaveArgs,
} as const;
