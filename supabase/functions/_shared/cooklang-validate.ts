/**
 * Cooklang source validation - catches authoring mistakes before a
 * row lands in the DB. Called by the recipe_save edge tool (both the
 * create and edit forms) so a bad save fails at the tool surface and
 * the model gets a corrective error it can act on, instead of the
 * recipe silently rendering wrong until the user notices. Also
 * re-exported to the browser through src/lib/cooklang.ts. Returns an
 * array of error messages; empty means no check fired.
 *
 * The parser never throws, so "is this valid Cooklang" is not a useful
 * question. Every check here answers a narrower one: "will the cook see
 * what the author wrote?" Each targets a mistake the model has made in
 * practice.
 *
 *   - Backtick code spans. Emphasis (`**bold**`, `*italic*`,
 *     `_italic_`) renders; code spans show literal backticks.
 *   - `@modifier @ingredient{...}`. Two adjacent `@` tokens produce a
 *     phantom "modifier" ingredient row plus the real one; the right
 *     form is one multi-word braced name.
 *   - Literal `\n` escapes. A double-escaped tool argument arrives as
 *     one long line; the structural checks are skipped when it fires.
 *   - Empty sections. `# Name` / `== Name ==` opens a section, and the
 *     renderer shows a section heading only when at least one line
 *     lands in it. A heading with nothing under it vanishes, so a note
 *     the model wrote as `# NOTE: ...` disappears without a trace.
 *     This check runs the real parser (cooklang-parse.ts) so it sees
 *     exactly the sections the renderer will group by.
 *   - `--` glued to a word or number. The line-comment rule strips from
 *     the first `--` to end of line, so "bake 20--25 min" renders as
 *     "bake 20". A comment the author meant has whitespace before it.
 *   - `##`-style headings. Only a single `#` (or `==`) is a heading;
 *     `## Sauce` renders as a numbered step reading "## Sauce".
 */

import { parseCooklang } from './cooklang-parse.ts';

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

  // Literal `\n` escapes instead of line breaks - a double-escaped tool
  // argument. The parser sees one giant line; when it starts with `@`
  // the whole recipe is a single ingredient declaration and none of the
  // instructions render. Checked first because the structural checks
  // below would only report confusing side effects of the same mistake.
  if (/\\n/.test(src)) {
    errors.push(
      'cooklang contains literal `\\n` escape sequences instead of real ' +
        'line breaks, so the whole recipe parses as one line and most of ' +
        'it will not render. Send the source with actual newlines.',
    );
    return errors;
  }

  errors.push(...emptySectionErrors(src));
  errors.push(...gluedCommentErrors(src));
  errors.push(...multiHashHeadingErrors(src));

  return errors;
}

/** Longest heading or line excerpt quoted back in an error message. */
const EXCERPT_CHARS = 80;

function excerpt(s: string): string {
  return s.length > EXCERPT_CHARS ? `${s.slice(0, EXCERPT_CHARS)}...` : s;
}

/**
 * Sections the renderer will drop because no line landed in them. The
 * renderer groups by each step's section name, so a name the parser
 * recorded with zero steps has no bucket and no heading. A name that
 * appears twice (once empty, once with lines) merges into one rendered
 * section and is fine.
 */
function emptySectionErrors(src: string): string[] {
  const recipe = parseCooklang(src);
  const populated = new Set(recipe.steps.map((s) => s.section));
  return recipe.sections
    .filter((name) => !populated.has(name))
    .map(
      (name) =>
        `section heading "${excerpt(name)}" has no lines under it, so it ` +
        'will not appear in the rendered recipe. `# Name` and `== Name ==` ' +
        'start a section; they are not comments, notes, or callouts. If ' +
        'this is a note for the cook, write it as a plain line of step ' +
        'text (bold a lead-in with `**Note:**` if you want it to stand ' +
        'out). If it is a parent heading over sub-sections, give it at ' +
        'least one line of its own or remove it.',
    );
}

/**
 * Lines where the `--` comment marker touches the text before it. The
 * parser strips from the first `--` to end of line (see parseCooklang),
 * so a range written as "20--25 minutes" silently loses "-25 minutes".
 * Mirrors the parser's order: block comments go first, and a dash-only
 * line is a section reset, not a comment.
 */
function gluedCommentErrors(src: string): string[] {
  const errors: string[] = [];
  for (const rawLine of src.replace(/\[-[\s\S]*?-\]/g, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^-{2,}$/.test(line)) continue;
    const at = line.indexOf('--');
    if (at > 0 && !/\s/.test(line[at - 1]!)) {
      errors.push(
        `"${excerpt(line)}" contains \`--\` right after other text. ` +
          '`--` starts a comment that hides the rest of the line, so ' +
          `everything from "${excerpt(line.slice(at))}" on will not render. ` +
          'Write ranges with a single hyphen or "to" (`20-25 minutes`). ' +
          'A deliberate comment needs a space before the `--`.',
      );
    }
  }
  return errors;
}

/**
 * `##`-style markdown headings. Only `# Name` is a heading alias; two or
 * more hashes fall through to an ordinary step whose text keeps the
 * hashes. Sub-sections use more `=` signs instead.
 */
function multiHashHeadingErrors(src: string): string[] {
  return src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^#{2,}\s/.test(l))
    .map(
      (l) =>
        `"${excerpt(l)}" is not a heading: only a single \`#\` starts a ` +
        'section, so this renders as a numbered step with literal `#` ' +
        'characters. Use `# Name` or `== Name ==` for a section and ' +
        '`=== Name ===` for a sub-section.',
    );
}
