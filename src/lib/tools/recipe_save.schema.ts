/**
 * Schema-only export for the recipe_save tool. The impl lives in
 * `./recipe_save` and imports this schema via spread. Splitting the
 * data half from the runtime half keeps the contract the LLM sees
 * (parameters, description) cleanly separated from the imperative
 * code that reacts to a tool call.
 */
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../cooklang';

export const recipeSaveSchema = {
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
    'the recipe was imported from the web. `change_message` is REQUIRED and ' +
    "appears in the recipe's history panel as the description of this " +
    'initial save (e.g. "Imported from NYT Cooking", "Captured from the ' +
    "user's handwritten card\"). Returns the created {id, title, updated_at}.",
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
      rating: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description:
          "Optional 1-5 star rating. Omit unless the user has explicitly " +
          "indicated how they feel about the recipe. The user's own rating " +
          'is the only thing that belongs here - never invent one based on ' +
          'reviews, popularity, or your own assessment.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          "One-line note describing why you are saving this recipe. " +
          'Stored in the recipe\'s version history and shown to the user ' +
          'in the History panel. Examples: "Imported from NYT Cooking", ' +
          '"Captured from prose the user pasted", "Adapted Smitten ' +
          "Kitchen pasta with the user's pantry constraints\".",
      },
    },
    required: ['title', 'cooklang', 'change_message'],
    additionalProperties: false,
  },
} as const;
