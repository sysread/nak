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
 *   - Leftover syntax. Any `{`, `}`, or `@` still present in the parsed
 *     output (step text, ingredient names and notes, section names) is
 *     markup the parser did not recognize, and the cook sees it raw:
 *     `{325°F}` (braces with no `%` are not a bare timer), an unclosed
 *     `@salt{1%tsp`, a stray `@ 350`. Checking the parse output rather
 *     than the source means a token the parser DID consume never fires.
 *   - Malformed amounts. A `%`, `{`, or `}` left inside a parsed qty or
 *     unit - `@flour{1/2%1%tsp}` splits on the first `%` and shows the
 *     unit as "1%tsp".
 *   - Timers without a unit. `~{12-15 min}` has no `%`, so the whole
 *     body parses as the duration with a null unit. The step text reads
 *     fine, but the renderer only lists timers with a recognized time
 *     unit, so this one silently drops out of the Timers list.
 *
 * Deliberately NOT flagged: a timer with a non-time unit
 * (`~{6,000%ft}`). The renderer keeps those out of the Timers list on
 * purpose (see TIME_UNITS in src/lib/cooklang-render.ts), so the text
 * reads fine.
 */

import { parseCooklang, type Recipe } from './cooklang-parse.ts';

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

  const recipe = parseCooklang(src);
  errors.push(...emptySectionErrors(recipe));
  errors.push(...gluedCommentErrors(src));
  errors.push(...multiHashHeadingErrors(src));
  errors.push(...leftoverSyntaxErrors(recipe));
  errors.push(...malformedAmountErrors(recipe));
  errors.push(...unitlessTimerErrors(recipe));

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
function emptySectionErrors(recipe: Recipe): string[] {
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

/**
 * Rendered strings that still carry Cooklang markup characters. The
 * tokenizer replaces every reference it recognizes with plain display
 * text, so a `{`, `}`, or `@` that survives into the parse output is
 * markup it skipped - and the renderer shows it verbatim. Ingredient
 * names are included because a parenthetical name segment can swallow
 * a brace (`@flour (sifted{1%cup})`).
 */
function leftoverSyntaxErrors(recipe: Recipe): string[] {
  const rendered = [
    ...recipe.steps.map((s) => s.text),
    ...recipe.steps.flatMap((s) => s.ingredients.flatMap((i) => [i.name, i.note ?? ''])),
    ...recipe.sections,
  ];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const text of rendered) {
    for (const line of text.split('\n')) {
      if (!/[{}@]/.test(line) || seen.has(line)) continue;
      seen.add(line);
      errors.push(
        `"${excerpt(line.trim())}" still shows raw Cooklang characters ` +
          '(`{`, `}`, or `@`) after parsing, so the cook will see them ' +
          'literally. Braces only mean something attached to a reference - ' +
          '`@name{qty%unit}`, `#name{}`, `~{qty%unit}`. Write plain values ' +
          '(temperatures, notes) without braces, close every `{` you open, ' +
          'and put the ingredient name right after `@` with no space.',
      );
    }
  }
  return errors;
}

/**
 * Parsed amounts that still contain markup. parseQtyUnit splits on the
 * FIRST `%`, so `{1/2%1%tsp}` yields qty "1/2" and unit "1%tsp", which
 * the ingredient list prints as written.
 */
function malformedAmountErrors(recipe: Recipe): string[] {
  const amounts = [
    ...recipe.steps.flatMap((s) =>
      s.ingredients.map((i) => ({ label: `@${i.name}`, qty: i.qty, unit: i.unit })),
    ),
    ...recipe.steps.flatMap((s) =>
      s.timers.map((t) => ({ label: `~${t.name ?? ''}`, qty: t.duration, unit: t.unit })),
    ),
  ];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const { label, qty, unit } of amounts) {
    const body = `${qty ?? ''}%${unit ?? ''}`;
    if (!/[%{}]/.test(`${qty ?? ''}${unit ?? ''}`) || seen.has(label + body)) continue;
    seen.add(label + body);
    errors.push(
      `${label}{${body}} has a malformed amount: a braced amount takes ` +
        'exactly one `%` between quantity and unit (`{1/2-1%tsp}`), so ' +
        'this renders with stray characters. Write a range with a hyphen ' +
        'and keep a single `%`.',
    );
  }
  return errors;
}

/**
 * Timers whose braces carried no `%`. Anonymous `~{...}` and named
 * `~name{...}` forms accept a body without one, so a duration written
 * with a space instead (`~{12-15 min}`) still tokenizes - as a duration
 * with no unit, which keeps it out of the Timers list.
 */
function unitlessTimerErrors(recipe: Recipe): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const t of recipe.steps.flatMap((s) => s.timers)) {
    if (t.unit !== null || t.duration.length === 0) continue;
    const written = `~${t.name ?? ''}{${t.duration}}`;
    if (seen.has(written)) continue;
    seen.add(written);
    // "12-15 min" -> "12-15%min"; a body with no trailing word gets no
    // guessed unit, just the rule.
    const fixed = t.duration.replace(/\s+(\S+)$/, '%$1');
    const hint = fixed.includes('%')
      ? `Write it as \`~${t.name ?? ''}{${fixed}}\`.`
      : 'Add a time unit after a `%`, e.g. `~{10%minutes}`.';
    errors.push(
      `${written} has no \`%\` between duration and unit, so it is ` +
        `missing from the Timers list. ${hint}`,
    );
  }
  return errors;
}
