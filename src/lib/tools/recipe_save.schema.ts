/**
 * Schema-only export for recipe_save. Impl lives in `./recipe_save`.
 */
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../cooklang';

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
    'change_message is REQUIRED and lands in the recipe history. ' +
    'Returns {id, title, updated_at}.',
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
      rating: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description:
          'Optional 1-5 star rating. Set ONLY when the user has ' +
          'explicitly told you how they feel about the recipe; never ' +
          'invent one from reviews or your own assessment.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          "One-line history note. Examples: \"Imported from NYT " +
          'Cooking", "Captured from prose the user pasted".',
      },
    },
    required: ['title', 'cooklang', 'change_message'],
    additionalProperties: false,
  },
} as const;
