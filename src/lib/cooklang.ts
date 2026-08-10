/**
 * Cooklang — a thin, browser-only parser for the Cooklang recipe DSL
 * (https://cooklang.org/docs/spec/). One of nak's very few subsystems
 * that deliberately avoids an upstream npm dep. The spec is small and
 * stable enough that an inline ~200-line reader is cheaper to reason
 * about than tracking a third-party parser across a future spec tweak.
 *
 * What the spec covers that matters here:
 *
 *   @ingredient{qty%unit}    → a named ingredient with optional qty+unit
 *   @multi-word ingredient{} → `{}` lets the name run past whitespace
 *   @salt                    → no braces, single-word ingredient
 *   #cookware{}              → a piece of cookware (no qty)
 *   ~timer{30%minutes}       → a timed step
 *   ~{30%minutes}            → anonymous timer (spec allows; we keep)
 *   >> key: value            → metadata header (servings, source, etc.)
 *   -- line comment          → stripped at read-time
 *   [- block comment -]      → stripped at read-time
 *
 * Extensions we implement on top of the narrow core spec:
 *
 *   == Section Name ==       → formal section delimiter (canonical
 *                              Cooklang extension; CookCLI, cooklang-ts
 *                              and others ship it). Starts a new
 *                              section; subsequent steps carry its name.
 *   # Section Name           → markdown-style alias for the same thing.
 *                              The space after `#` is what disambiguates
 *                              from `#cookware` (no space), so layering
 *                              it on costs nothing. Kept because the LLM
 *                              reaches for markdown headers by reflex
 *                              when writing long recipes.
 *   > continuation text      → AnyList's tradition for wrapping a long
 *                              step across lines. Merged into the
 *                              previous step's text so the renderer sees
 *                              one numbered instruction instead of a
 *                              shredded sequence.
 *   @-first declaration line → a line whose first non-whitespace char
 *                              is `@` is an ingredient declaration:
 *                              it contributes to the ingredients list
 *                              (and per-section ingredient grouping) but
 *                              is NOT rendered as a numbered instruction
 *                              step. Matches the cookbook-style "list
 *                              of ingredients at the top, instructions
 *                              below" the LLM reaches for naturally.
 *                              A line that starts with prose and
 *                              references ingredients inline (`Add the
 *                              @chicken{1%lb} to the pot.`) is still a
 *                              regular instruction step.
 *   @?ingredient{...}        → optional-ingredient modifier. Not in the
 *                              canonical spec (cooklang.org/docs/spec has
 *                              no optionality), but it is the `?` component
 *                              modifier from the official cooklang-rs
 *                              parser's extensions and the syntax the spec
 *                              maintainer favoured in cooklang/spec
 *                              discussion #50 - so recipes stay readable
 *                              by the wider Cooklang ecosystem. Ingredients
 *                              only; cooklang-rs also allows `#?cookware`,
 *                              but nak's cookware list is a flat "what
 *                              tools do I need" aside where optionality
 *                              has no rendering to hang off.
 *   ---- (dash-only line)    → section reset: a line whose non-whitespace
 *                              content is only dashes (2+) clears the
 *                              current section so subsequent steps attach
 *                              to the implicit head bucket. Lets a source
 *                              say "end of declaration block, start of
 *                              instructions" without another named
 *                              section. Previously a no-op (the comment
 *                              pass stripped `--` to empty), so this is
 *                              additive and breaks no existing recipe.
 *
 * What we deliberately don't implement:
 *
 *   - Shopping-list extensions — nak isn't a shopping list; AnyList is.
 *     Users transfer recipes out of nak into AnyList and let AnyList do
 *     shopping-list rollup.
 *   - Recipe references (@path/to/recipe.cook{}) — a personal cookbook
 *     doesn't need cross-recipe inclusion, and a bad reference would
 *     silently render as plain text with no way to detect the mistake.
 *
 * The renderers (HTML, plain text, markdown, TOC) live in
 * `./cooklang-render` and are re-exported from here so existing
 * consumers keep a single import surface.
 */

export interface Ingredient {
  name: string;
  /** `null` when the user didn't write a quantity (e.g. `@salt`). */
  qty: string | null;
  /** `null` when the user didn't write a unit (e.g. `@eggs{2}`). */
  unit: string | null;
  /**
   * `true` when written with the `@?` optional-ingredient modifier
   * (`@?cilantro{2%tbsp}`). Renderers tag these "(optional)" in the
   * ingredient lists; step prose shows just the name, since the
   * sentence around it already carries the hedging ("if using").
   */
  optional: boolean;
  /**
   * Free text the author wrote after the `{}` on a declaration line,
   * e.g. `@Butter{3%tbsp} or neutral oil` carries `note: "or neutral
   * oil"`. Null when the declaration had no trailing text, when the
   * line had multiple ingredients (the note can't be assigned to one),
   * or for ingredients extracted from instruction prose (not
   * declarations). Renderers show the note after the ingredient,
   * muted, so the cook sees alternatives and prep hints at a glance.
   */
  note: string | null;
}

export interface Cookware {
  name: string;
}

export interface Timer {
  /** `null` for an anonymous timer (`~{30%minutes}`). */
  name: string | null;
  /** Duration as written, not normalised — the user's text wins. */
  duration: string;
  unit: string | null;
}

/** A single instruction line with inline references to structured items. */
export interface Step {
  /** Rendered text of the step, with references expanded to plain names. */
  text: string;
  /** Ingredients, cookware, and timers that appeared inline on this line. */
  ingredients: Ingredient[];
  cookware: Cookware[];
  timers: Timer[];
  /**
   * Section this step belongs to, or `null` for the implicit head
   * section (steps that appear before any `== Name ==` / `# Name`
   * header). The renderer uses this to group the ingredients and
   * instructions under sub-headings; absence of any section → the
   * renderer falls back to flat output, matching pre-section behaviour.
   */
  section: string | null;
  /**
   * Depth of the `==` header that opened this step's section: 2 for
   * `== Name ==` or `# Name` (the `#` alias defaults to depth 2), 3
   * for `=== Name ===`, and so on. `null` for steps in the implicit
   * head section (before any section header, or after a dash-only
   * reset). The renderer uses this to pick a heading level so nested
   * sub-sections nest visually - depth 2 -> h4 / `###`, depth 3 -> h5
   * / `####`, depth 4 -> h6 / `#####`. See `sectionHtmlTag` /
   * `sectionMarkdownPrefix` in `cooklang-render.ts`.
   */
  sectionDepth: number | null;
  /**
   * `'instruction'` for a regular numbered step (prose with inline
   * references). `'declaration'` for a line whose first non-whitespace
   * char is `@` — the line contributes ingredients/cookware/timers to
   * the flat + per-section lists but does NOT render in the numbered
   * instructions output. The field is kept on Step (rather than split
   * into a separate `declarations: Step[]` array) so the section-
   * aware ingredient dedupe can walk a single steps list in source
   * order without losing which section each declaration belongs to.
   */
  kind: 'instruction' | 'declaration';
}

export interface Recipe {
  /** `>> key: value` headers in declaration order. */
  metadata: Record<string, string>;
  /** One entry per non-empty, non-comment source line. */
  steps: Step[];
  /** Flat deduplicated list across every step — convenient for the UI. */
  ingredients: Ingredient[];
  cookware: Cookware[];
  timers: Timer[];
  /**
   * Section names in the order they first appeared in the source. An
   * empty array means the source had no section headers — the
   * renderer then emits a single flat ingredients list and one
   * numbered instructions list, same as before sections existed.
   */
  sections: string[];
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Split `qty%unit` into its pieces. Both sides optional. The `%` is the
 * Cooklang separator; it appears inside `{…}` only. We accept leading /
 * trailing whitespace because recipe text often has friendly spacing
 * (`{ 1 / 2 % cup }`).
 */
function parseQtyUnit(inner: string): { qty: string | null; unit: string | null } {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return { qty: null, unit: null };
  const pctIdx = trimmed.indexOf('%');
  if (pctIdx === -1) return { qty: trimmed, unit: null };
  const qty = trimmed.slice(0, pctIdx).trim();
  const unit = trimmed.slice(pctIdx + 1).trim();
  return {
    qty: qty.length > 0 ? qty : null,
    unit: unit.length > 0 ? unit : null,
  };
}

/**
 * Parse a `>> key: value` metadata line. Returns null if the line isn't
 * actually metadata — the caller falls back to treating it as a step.
 * The spec requires `>>` at the start of the line (after optional
 * whitespace); the colon is mandatory.
 */
function tryParseMetadata(line: string): { key: string; value: string } | null {
  const m = /^\s*>>\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
  if (!m) return null;
  return { key: m[1]!, value: m[2]! };
}

/**
 * Recognise a section header line. Returns the section name and the
 * header depth, or null if the line isn't a header and should be
 * treated as content.
 *
 * Two accepted forms, intentionally liberal on padding:
 *
 *   == Section Name ==   canonical Cooklang extension. Any run of `=`
 *                        on either side, optional inner whitespace.
 *                        The depth is the count of `=` signs on the
 *                        left side (they should match, but we use the
 *                        left). `==` is depth 2, `===` is depth 3,
 *                        `====` is depth 4, etc.
 *   # Section Name       markdown-style alias. The space after `#` is
 *                        what separates this from `#cookware` (no space,
 *                        immediately followed by a name char) - the
 *                        inline cookware regex requires a name char
 *                        right after `#`, so there's no collision.
 *                        Defaults to depth 2 (same as `==`) so the
 *                        renderer emits the same heading level.
 *
 * Multi-hash (`##`, `###`, etc.) is not matched on purpose - the LLM
 * reaches for `#` without ceremony, and matching deeper levels would
 * force us to decide what nesting means to the renderer. If a use case
 * for sub-sections shows up, extend here; today flat is enough.
 */
function tryParseSectionHeader(line: string): { name: string; depth: number } | null {
  const fancy = /^(={2,})\s*(.+?)\s*={2,}\s*$/.exec(line);
  if (fancy) {
    const name = fancy[2]!.trim();
    return name.length > 0 ? { name, depth: fancy[1]!.length } : null;
  }
  const md = /^#\s+(.+?)\s*$/.exec(line);
  if (md) {
    const name = md[1]!.trim();
    return name.length > 0 ? { name, depth: 2 } : null;
  }
  return null;
}

/**
 * Pull a `>` continuation marker off the front of a line. Returns the
 * trailing text (possibly empty) when the line opens with `>` followed
 * by whitespace or end-of-line, or null for non-continuation lines.
 * `>>` is NOT matched here — metadata is tried first by the caller, so
 * a genuine `>> key: value` header never reaches this function.
 */
function tryParseContinuation(line: string): string | null {
  // `>` + end-of-line, or `>` + whitespace + body. Guard against `>>`
  // (metadata) by requiring the second char to be whitespace or absent.
  const m = /^>(?:\s+(.*))?$/.exec(line);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

/**
 * Recognise a "section reset" line: non-whitespace content is only
 * dashes (2+). Triggered BEFORE comment stripping, because the line
 * comment pass (`--` to end of line) would otherwise erase the dashes
 * and leave an empty line that we can't distinguish from a blank.
 *
 * Why this extension: the LLM naturally writes recipes as an
 * ingredient-declaration block (one `@name{qty%unit}` per line, grouped
 * by `# Section` headers) followed by a horizontal rule and then the
 * actual cooking prose. Without a reset marker, the instructions
 * inherit whatever section was last declared (usually "For serving" or
 * similar), which mis-groups them under a sub-heading that isn't
 * theirs. A dash-only line says "end of declarations, flat instructions
 * follow" and leaves no ambiguity for the parser or the reader.
 *
 * Previously a dash-only line was a no-op comment, so this is additive:
 * no recipe that parsed before now parses differently.
 */
function isSectionReset(line: string): boolean {
  return /^\s*-{2,}\s*$/.test(line);
}

/**
 * Recognise an ingredient-declaration line: first non-whitespace char
 * is `@`. Declaration lines contribute ingredients (and incidental
 * cookware / timers, though those are rare in a declaration block) to
 * the recipe's flat + per-section lists, but do NOT render as numbered
 * instruction steps.
 *
 * The heuristic is deliberately narrow — "starts with `@`" — rather
 * than "contains only ingredient references and prose modifiers".
 * Detecting "this prose has a verb" is brittle, and a cook who really
 * wants a step to lead with an ingredient can rephrase ("Add @salt"
 * instead of "@salt to taste"). The LLM's cookbook-style output
 * always puts a prose verb first on genuine instruction lines.
 */
function isDeclarationLine(line: string): boolean {
  return /^\s*@/.test(line);
}

/**
 * Token patterns for the three inline reference types. Multi-word
 * names are legal ONLY when braces close them — otherwise `@salt and
 * @pepper` would grow "salt and" onto one token, swallowing words the
 * user meant as prose. Each regex has two alternatives:
 *
 *   @(multi word){body}   → group 1 = name, group 2 = body
 *   @single               → group 3 = name (no body possible)
 *
 * Name character class: letters, digits, and a small allow-list
 * (`-`, `_`, `'`) so "olive-oil", "crème_fraîche", "grandmother's
 * chutney" all behave. Unicode letter support via `\p{L}` — modern
 * browsers all support the `u` flag.
 *
 * Inside the braced form the name is a "run" of segments, where a
 * segment is either a word of name-chars OR a parenthetical note like
 * "(all-purpose)". Only `{` ends the name - a `(` does not. Without
 * this, `@flour (all-purpose){200%g}` breaks the name at the `(`, the
 * braced alternative fails to find `{` right after "flour", the bare
 * alternative claims just "flour" with no quantity, and the orphaned
 * `{200%g}` is then misread by the bare-brace pass as a phantom "200 g"
 * timer. Allowing parenthetical segments keeps the braces bound to the
 * ingredient so the qty/unit survive. The run is braced-form only; the
 * bare `@name` alternative stays single-word on purpose (otherwise
 * `@salt and @pepper` would swallow "and").
 */
const NAME_CHARS = "[\\p{L}\\p{N}\\-_']";
const NAME_SEGMENT = `(?:${NAME_CHARS}+|\\([^)]*\\))`;
const NAME_RUN = `${NAME_SEGMENT}(?:[ \\t]${NAME_SEGMENT})*`;
// Group 1 is the `?` optional-ingredient modifier (`@?name` - see the
// preamble). `?` is not a name char, so a `?` that isn't immediately
// followed by a name (e.g. a literal "@? " in prose) fails both
// alternatives and stays plain text.
const INGREDIENT_RE = new RegExp(
  `@(\\??)(?:(${NAME_RUN})\\{([^}]*)\\}|(${NAME_CHARS}+))`,
  'gu'
);
const COOKWARE_RE = new RegExp(
  `#(?:(${NAME_RUN})\\{([^}]*)\\}|(${NAME_CHARS}+))`,
  'gu'
);
// Timers differ: `~` allows an empty name (anonymous timer) as long as
// braces follow, so we split the anonymous case out to a second match
// pass rather than making group 1 optional and muddying the regex.
// Named timers always carry a body, so there's no "bare name" alt here.
const TIMER_NAMED_RE = new RegExp(
  `~(${NAME_RUN})\\{([^}]*)\\}`,
  'gu'
);
const TIMER_ANON_RE = /~\{([^}]*)\}/gu;
// Bare braced duration: `{qty%unit}` with no `@`/`#`/`~` prefix. The
// LLM frequently drops the `~` when writing a duration (especially when
// it also wraps the duration in markdown bold like `**{4-5%hours}**`,
// where the asterisks visually substitute for the missing prefix).
// Without this, the parser would leave `{4-5%hours}` as literal prose
// and the renderer would show curly braces in the step text. Requiring
// `%` in the body keeps us from grabbing arbitrary `{...}` prose that
// wasn't meant as a duration. The overlap check in `tokenizeLine`
// guards against re-claiming spans inside an `@`/`#`/`~` reference.
const TIMER_BARE_RE = /\{([^}]*%[^}]*)\}/gu;

interface LineTokens {
  text: string;
  ingredients: Ingredient[];
  cookware: Cookware[];
  timers: Timer[];
}

/**
 * Extract every `@`, `#`, and `~` reference from a single step line,
 * returning the structured pieces plus a plain-text rendering with the
 * references replaced by their display names. The display-name fallback
 * for no-brace single-word tokens means `@salt` renders as "salt".
 *
 * The algorithm walks each regex in turn and builds a replacement map;
 * we do the text replacement in one pass at the end so overlapping
 * ranges can't corrupt each other (they shouldn't overlap in well-formed
 * Cooklang, but the spec doesn't forbid weird input and a robust parser
 * is cheaper than a debugging session six months from now).
 */
function tokenizeLine(line: string): LineTokens {
  const ingredients: Ingredient[] = [];
  const cookware: Cookware[] = [];
  const timers: Timer[] = [];
  // Replacements stored as [startIdx, endIdx, displayText] and applied
  // in reverse so earlier indices stay valid during the rewrite.
  const edits: Array<[number, number, string]> = [];

  for (const m of line.matchAll(INGREDIENT_RE)) {
    // Group 1 = optional-modifier marker; group 2 + 3 = braced form
    // `@name{body}`; group 4 = bare `@name`.
    const optional = m[1] === '?';
    const name = (m[2] ?? m[4]!).trim();
    const body = m[3];
    const { qty, unit } = body !== undefined ? parseQtyUnit(body) : { qty: null, unit: null };
    ingredients.push({ name, qty, unit, optional, note: null });
    edits.push([m.index!, m.index! + m[0].length, name]);
  }
  for (const m of line.matchAll(COOKWARE_RE)) {
    const name = (m[1] ?? m[3]!).trim();
    cookware.push({ name });
    edits.push([m.index!, m.index! + m[0].length, name]);
  }
  for (const m of line.matchAll(TIMER_NAMED_RE)) {
    const name = m[1]!.trim();
    const { qty, unit } = parseQtyUnit(m[2]!);
    timers.push({ name: name.length > 0 ? name : null, duration: qty ?? '', unit });
    const display = unit ? `${qty ?? ''} ${unit}`.trim() : (qty ?? name);
    edits.push([m.index!, m.index! + m[0].length, display]);
  }
  // Anonymous timer pass — skip any span already covered by TIMER_NAMED_RE
  // above. We check overlap against the edits list rather than re-running
  // the named regex; the edits list is already authoritative.
  for (const m of line.matchAll(TIMER_ANON_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const overlaps = edits.some(([s, e]) => s <= start && e >= end);
    if (overlaps) continue;
    const { qty, unit } = parseQtyUnit(m[1]!);
    timers.push({ name: null, duration: qty ?? '', unit });
    const display = unit ? `${qty ?? ''} ${unit}`.trim() : (qty ?? '');
    edits.push([start, end, display]);
  }
  // Bare-brace duration pass: `{qty%unit}` with no prefix. Runs LAST so
  // it can't steal a span from `@ingredient{200%g}` (the ingredient
  // pass already recorded an edit covering the whole `@...{...}` range,
  // and our `{200%g}` match falls inside it). Same overlap guard as the
  // anonymous-timer pass above.
  for (const m of line.matchAll(TIMER_BARE_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const overlaps = edits.some(([s, e]) => s <= start && e >= end);
    if (overlaps) continue;
    const { qty, unit } = parseQtyUnit(m[1]!);
    timers.push({ name: null, duration: qty ?? '', unit });
    const display = unit ? `${qty ?? ''} ${unit}`.trim() : (qty ?? '');
    edits.push([start, end, display]);
  }

  // Apply edits right-to-left so earlier indices stay valid.
  edits.sort((a, b) => b[0] - a[0]);
  let text = line;
  for (const [s, e, display] of edits) {
    text = text.slice(0, s) + display + text.slice(e);
  }

  return { text, ingredients, cookware, timers };
}

/**
 * Parse Cooklang source into a structured {@link Recipe}. Never throws —
 * malformed input produces a partial result rather than an error, on
 * the principle that a cookbook view should always render *something*
 * even when the source has a typo. Callers that care about validation
 * should inspect the `steps` array (an empty steps list usually means
 * the user hasn't started writing yet).
 */
export function parseCooklang(src: string): Recipe {
  // Block comments are stripped up front (they can span lines, so
  // per-line handling can't see their extent). Line-level `--`
  // comments are stripped per-line below, AFTER the dash-only reset
  // check — otherwise `--` alone on a line would be erased to empty
  // and indistinguishable from a blank line.
  const blockStripped = src.replace(/\[-[\s\S]*?-\]/g, '');
  const metadata: Record<string, string> = {};
  const steps: Step[] = [];
  const sections: string[] = [];
  const allIngredients: Ingredient[] = [];
  const allCookware: Cookware[] = [];
  const allTimers: Timer[] = [];
  // Tracks the section the next step will attach to. Starts null - the
  // "implicit head section" that groups any steps written before the
  // first explicit header.
  let currentSection: string | null = null;
  // Depth of the current section header (2 for `==`, 3 for `===`, etc).
  // Null for the implicit head section and after a dash-only reset.
  let currentSectionDepth: number | null = null;

  for (const rawLine of blockStripped.split(/\r?\n/)) {
    const preStrip = rawLine.trim();

    // Dash-only section reset runs BEFORE line-comment stripping. A
    // line that is only dashes would otherwise be erased to empty by
    // the `--` pass and collapse into a normal blank line — losing
    // the author's intent to "end the current section".
    if (preStrip.length > 0 && isSectionReset(preStrip)) {
      currentSection = null;
      currentSectionDepth = null;
      continue;
    }

    // Line-level `--` comment stripping, applied per-line here so the
    // reset check above can see the raw dashes. Leaves any text before
    // `--` intact so `Add @salt. -- to taste` still yields the step
    // "Add salt.".
    const line = preStrip.replace(/--[^\n]*$/, '').trim();
    if (line.length === 0) continue;

    // Metadata first so a genuine `>> key: value` never reaches the
    // continuation matcher (which would misread `>>foo` as `> >foo`).
    const meta = tryParseMetadata(line);
    if (meta) {
      metadata[meta.key] = meta.value;
      continue;
    }

    // Section header: switches the bucket every following step lands
    // in. The header line itself is not a step; it produces no text.
    const sectionHeader = tryParseSectionHeader(line);
    if (sectionHeader !== null) {
      currentSection = sectionHeader.name;
      currentSectionDepth = sectionHeader.depth;
      if (!sections.includes(sectionHeader.name)) sections.push(sectionHeader.name);
      continue;
    }

    // Continuation: merge into the previous step's text + references.
    // If there is no previous step (e.g. a recipe that opens with a
    // stray `> line`), fall through and treat the body as a fresh
    // step — better a visible step than a silently-dropped line.
    const continuation = tryParseContinuation(line);
    if (continuation !== null) {
      // A continuation only merges into an instruction step — a
      // declaration-only line has no rendered prose for the
      // continuation to extend, and grafting a `>` body onto the
      // ingredient block would re-introduce the "ingredients mixed
      // into instructions" confusion this parser is trying to avoid.
      const prev = steps[steps.length - 1];
      const anchor = prev && prev.kind === 'instruction' ? prev : undefined;
      if (anchor) {
        if (continuation.length > 0) {
          const tok = tokenizeLine(continuation);
          anchor.text = anchor.text.length > 0 ? `${anchor.text} ${tok.text}` : tok.text;
          anchor.ingredients.push(...tok.ingredients);
          anchor.cookware.push(...tok.cookware);
          anchor.timers.push(...tok.timers);
          allIngredients.push(...tok.ingredients);
          allCookware.push(...tok.cookware);
          allTimers.push(...tok.timers);
        }
        continue;
      }
      // No anchor to merge into — let the rest of this iteration treat
      // the continuation body as a regular step line. An empty body
      // (bare `>`) degrades to nothing; skip to the next line.
      if (continuation.length === 0) continue;
      const tok = tokenizeLine(continuation);
      steps.push({
        text: tok.text,
        ingredients: tok.ingredients,
        cookware: tok.cookware,
        timers: tok.timers,
        section: currentSection,
        sectionDepth: currentSectionDepth,
        kind: 'instruction',
      });
      allIngredients.push(...tok.ingredients);
      allCookware.push(...tok.cookware);
      allTimers.push(...tok.timers);
      continue;
    }

    // Declaration-only line: ingredients/cookware/timers contribute to
    // the flat + per-section lists, but no numbered instruction step
    // is emitted. See `isDeclarationLine` for why "starts with `@`" is
    // the right heuristic.
    const declaration = isDeclarationLine(line);
    const tok = tokenizeLine(line);

    // For single-ingredient declaration lines, extract the note text
    // the author wrote after the `{}`. tokenizeLine replaces the
    // `@name{qty%unit}` token with just `name`, so the text is
    // "name <rest of line>". Stripping the leading ingredient name
    // leaves the note. Leading punctuation (commas, semicolons) that
    // authors put between the {} and the note is stripped so the note
    // reads cleanly. Only applies when one ingredient is on the line -
    // with multiple, the text interleaves names and we can't assign
    // the note to one.
    if (declaration && tok.ingredients.length === 1) {
      const ing = tok.ingredients[0]!;
      const afterName = tok.text.trimStart().slice(ing.name.length).trim();
      const cleaned = afterName.replace(/^[,;:.\s]+/, '').trim();
      if (cleaned.length > 0) {
        ing.note = cleaned;
      }
    }

    steps.push({
      text: declaration ? '' : tok.text,
      ingredients: tok.ingredients,
      cookware: tok.cookware,
      timers: tok.timers,
      section: currentSection,
      sectionDepth: currentSectionDepth,
      kind: declaration ? 'declaration' : 'instruction',
    });
    allIngredients.push(...tok.ingredients);
    allCookware.push(...tok.cookware);
    allTimers.push(...tok.timers);
  }

  // If the author used declaration-style lines anywhere, the ingredient
  // list is authored (not derived from prose mentions): only declaration
  // steps contribute. Instruction lines that re-mention `@chicken` for
  // cross-reference would otherwise double-count against the declared
  // row. Cookware and timers are deduplicated from the full union across
  // all steps - those appear naturally in instructions, not in
  // declaration blocks.
  const hasDeclarations = steps.some((s) => s.kind === 'declaration');
  const ingredientSource = hasDeclarations
    ? steps.filter((s) => s.kind === 'declaration').flatMap((s) => s.ingredients)
    : allIngredients;

  return {
    metadata,
    steps,
    ingredients: dedupeIngredients(ingredientSource),
    cookware: dedupeCookware(allCookware),
    timers: dedupeTimers(allTimers),
    sections,
  };
}

/**
 * Collapse duplicate ingredient rows into one, keeping the first qty/unit
 * pair we saw. We don't try to sum quantities across the same ingredient
 * — "1 cup flour" and "2 tbsp flour" are different amounts that a human
 * reader wants to see both of. The dedupe only merges rows that are
 * genuinely identical (same name, same qty, same unit, same
 * optionality — a required `@salt` and an optional `@?salt` are two
 * different asks and both belong in the list).
 */
function dedupeIngredients(items: Ingredient[]): Ingredient[] {
  const seen = new Set<string>();
  const out: Ingredient[] = [];
  for (const it of items) {
    const key = `${it.name.toLowerCase()}|${it.qty ?? ''}|${it.unit ?? ''}|${it.optional ? '?' : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function dedupeCookware(items: Cookware[]): Cookware[] {
  const seen = new Set<string>();
  const out: Cookware[] = [];
  for (const it of items) {
    const key = it.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * Collapse duplicate timer rows - same name (or both anonymous),
 * same duration, same unit. A step that mentions `~{30%minutes}`
 * twice (or two steps that both say "simmer for ~{30%minutes}") should
 * render one timer entry, not two. Named timers dedupe against
 * themselves; an anonymous `~{30%minutes}` and a named
 * `~rest{30%minutes}` are different timers and both survive.
 */
function dedupeTimers(items: Timer[]): Timer[] {
  const seen = new Set<string>();
  const out: Timer[] = [];
  for (const it of items) {
    const key = `${it.name ?? ''}|${it.duration}|${it.unit ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renderer re-exports
// ---------------------------------------------------------------------------
// The HTML, plain-text, markdown, and TOC renderers live in
// `./cooklang-render`. They are re-exported here so existing consumers
// that import from `$lib/cooklang` don't break. New consumers can
// import from either module - the parser types (Recipe, Step, etc.)
// stay here, the renderers and their option types live there.

export { recipeToHtml, cooklangToHtml, recipeToc, recipeToPlainText, recipeToMarkdown } from './cooklang-render';
export type { RecipeHtmlOptions, RecipeTocSection, RecipeTocEntry } from './cooklang-render';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

// MAX_RECIPE_COOKLANG_CHARS and MAX_RECIPE_TITLE_CHARS used to live
// here. They moved to `./recipe-limits` so the always-on recipe-save
// tool schemas can reach them without dragging this 14 kB parser into
// the main chunk. Cookbook.svelte and the recipe tools now import
// directly from `./recipe-limits`.

// ---------------------------------------------------------------------------
// Authoring validation
// ---------------------------------------------------------------------------

/**
 * Catch the LLM-authoring quirks the parser tolerates but the renderer
 * can't make readable. Called from `recipe_save` and `recipe_update`
 * BEFORE the write hits the DB, so a malformed save fails at the tool
 * surface and the LLM gets a corrective error it can act on — far
 * cheaper than silently storing source that renders wrong and waiting
 * for the user to notice. Returns an array of error messages (empty =
 * source is valid as far as these checks are concerned).
 *
 * The checks here are deliberately narrow. They target patterns we've
 * observed the LLM produce, NOT a general "is this valid Cooklang"
 * pass — the parser itself is the source of truth for parse validity
 * (and never throws). A check that fires here means "this source will
 * not look right to the cook," not "this source is unparseable."
 *
 * Current checks:
 *
 *   1. Backtick code spans. The renderer supports inline emphasis
 *      (`**bold**`, `*italic*`, `_italic_`) but NOT code spans, and
 *      a recipe with `` `like this` `` would show literal backticks.
 *      Reject so the LLM drops the code-span habit.
 *   2. `@modifier @ingredient{...}` pattern. The LLM sometimes reaches
 *      for two adjacent `@` tokens to qualify an ingredient with a
 *      leading modifier (`@pre-minced @garlic{1%tbsp}`). The parser
 *      faithfully produces two ingredients — `pre-minced` (no qty)
 *      and `garlic` (1 tbsp) — which shows in the list as a phantom
 *      "pre-minced" row and a duplicate of an existing `@garlic`
 *      entry. The right form is a single multi-word braced name:
 *      `@pre-minced garlic{1%tbsp}`.
 *
 * What we DON'T flag (anymore): `**bold**`, `*italic*`, `_italic_`
 * markdown emphasis. The HTML renderer now picks these up in step
 * text via `renderInlineEmphasis`. Plain-text and markdown exports
 * leave them as authored.
 */
export { validateCooklangSource } from '$shared/cooklang-validate';
