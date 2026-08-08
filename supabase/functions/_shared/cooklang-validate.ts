/**
 * Cooklang source validation - catches LLM-authoring quirks before
 * a row lands in the DB. Pure function: two regexes, no deps, safe
 * for both the browser (src/lib/cooklang.ts) and the edge function
 * tools (recipe_save.ts, recipe_update.ts) to import.
 *
 * The browser-side src/lib/cooklang.ts was the canonical source but
 * the edge tools maintained their own copies with drifted error
 * messages. This module is now the single source for the validation
 * logic and the error wording.
 *
 * What it checks:
 *   - Backtick code spans (not valid Cooklang; render as literal
 *     backticks). Inline emphasis (`**bold**`, `*italic*`,
 *     `_italic_`) IS supported and not flagged.
 *   - `@modifier @ingredient{...}` pattern (produces two separate
 *     ingredient entries instead of one multi-word name).
 *
 * What it does NOT check: markdown emphasis (the HTML renderer
 * handles it), recipe structure, or Cooklang syntax in general.
 */

export function validateCooklangSource(src: string): string[] {
  const errors: string[] = [];

  // Backtick code spans - `like this`. Single-line only so we don't
  // misfire on a recipe that happens to have two backticks far apart.
  if (/`[^`\n]+`/.test(src)) {
    errors.push(
      'markdown code spans (`like this`) are not valid Cooklang and ' +
        'render as literal backticks. Remove the backticks; plain text ' +
        'in a step is already prose. (Inline emphasis is supported - ' +
        '`**bold**`, `*italic*`, and `_italic_` all render in step ' +
        'text - but code spans are not.)',
    );
  }

  // `@modifier @ingredient{...}` - two `@`-tokens separated only by
  // whitespace, with the SECOND one carrying a `{` body. Whitespace-
  // only between is what marks this as "modifier + thing"; any prose
  // between (`@salt and @pepper`) is a legitimate "two ingredients
  // mentioned in the same sentence" pattern and shouldn't fire. The
  // `\??` after each `@` keeps the check effective when either token
  // also carries the optional-ingredient modifier (`@?`).
  const NAME = "[\\p{L}\\p{N}\\-_']+";
  const MODIFIER_PAIR_RE = new RegExp(`@\\??${NAME}[ \\t]+@\\??${NAME}\\{`, 'u');
  if (MODIFIER_PAIR_RE.test(src)) {
    errors.push(
      'detected `@modifier @ingredient{...}` pattern (e.g. `@pre-minced ' +
        '@garlic{1%tbsp}`). This produces two separate ingredient entries ' +
        'because each `@token` is its own ingredient. Write modifier + ' +
        'ingredient as a single multi-word name inside braces: ' +
        '`@pre-minced garlic{1%tbsp}`. For "use X or Y" alternatives, put ' +
        'only the primary on `@` and write the substitute as plain prose: ' +
        '`@garlic{4%cloves} smashed (or 1 tbsp pre-minced garlic)`.',
    );
  }

  return errors;
}
