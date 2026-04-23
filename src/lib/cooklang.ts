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
 * Why cooklangToHtml lives in this file and not a renderer subsystem:
 *   the parse step produces a typed AST, and the HTML projection is a
 *   straight walk over that AST. Keeping both in one file means a future
 *   reader sees the full story — parse → render — without chasing
 *   imports across two modules.
 */

export interface Ingredient {
  name: string;
  /** `null` when the user didn't write a quantity (e.g. `@salt`). */
  qty: string | null;
  /** `null` when the user didn't write a unit (e.g. `@eggs{2}`). */
  unit: string | null;
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
 * Recognise a section header line. Returns the section name, or null
 * if the line isn't a header and should be treated as content.
 *
 * Two accepted forms, intentionally liberal on padding:
 *
 *   == Section Name ==   canonical Cooklang extension. Any run of `=`
 *                        on either side, optional inner whitespace.
 *   # Section Name       markdown-style alias. The space after `#` is
 *                        what separates this from `#cookware` (no space,
 *                        immediately followed by a name char) — the
 *                        inline cookware regex requires a name char
 *                        right after `#`, so there's no collision.
 *
 * Multi-hash (`##`, `###`, etc.) is not matched on purpose — the LLM
 * reaches for `#` without ceremony, and matching deeper levels would
 * force us to decide what nesting means to the renderer. If a use case
 * for sub-sections shows up, extend here; today flat is enough.
 */
function tryParseSectionHeader(line: string): string | null {
  const fancy = /^==+\s*(.+?)\s*==+$/.exec(line);
  if (fancy) {
    const name = fancy[1]!.trim();
    return name.length > 0 ? name : null;
  }
  const md = /^#\s+(.+?)\s*$/.exec(line);
  if (md) {
    const name = md[1]!.trim();
    return name.length > 0 ? name : null;
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
 */
const NAME_CHARS = "[\\p{L}\\p{N}\\-_']";
const INGREDIENT_RE = new RegExp(
  `@(?:(${NAME_CHARS}+(?:[ \\t]${NAME_CHARS}+)*)\\{([^}]*)\\}|(${NAME_CHARS}+))`,
  'gu'
);
const COOKWARE_RE = new RegExp(
  `#(?:(${NAME_CHARS}+(?:[ \\t]${NAME_CHARS}+)*)\\{([^}]*)\\}|(${NAME_CHARS}+))`,
  'gu'
);
// Timers differ: `~` allows an empty name (anonymous timer) as long as
// braces follow, so we split the anonymous case out to a second match
// pass rather than making group 1 optional and muddying the regex.
// Named timers always carry a body, so there's no "bare name" alt here.
const TIMER_NAMED_RE = new RegExp(
  `~(${NAME_CHARS}+(?:[ \\t]${NAME_CHARS}+)*)\\{([^}]*)\\}`,
  'gu'
);
const TIMER_ANON_RE = /~\{([^}]*)\}/gu;

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
    // Group 1 + 2 = braced form `@name{body}`; group 3 = bare `@name`.
    const name = (m[1] ?? m[3]!).trim();
    const body = m[2];
    const { qty, unit } = body !== undefined ? parseQtyUnit(body) : { qty: null, unit: null };
    ingredients.push({ name, qty, unit });
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
  // Tracks the section the next step will attach to. Starts null — the
  // "implicit head section" that groups any steps written before the
  // first explicit header.
  let currentSection: string | null = null;

  for (const rawLine of blockStripped.split(/\r?\n/)) {
    const preStrip = rawLine.trim();

    // Dash-only section reset runs BEFORE line-comment stripping. A
    // line that is only dashes would otherwise be erased to empty by
    // the `--` pass and collapse into a normal blank line — losing
    // the author's intent to "end the current section".
    if (preStrip.length > 0 && isSectionReset(preStrip)) {
      currentSection = null;
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
    const sectionName = tryParseSectionHeader(line);
    if (sectionName !== null) {
      currentSection = sectionName;
      if (!sections.includes(sectionName)) sections.push(sectionName);
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
    steps.push({
      text: declaration ? '' : tok.text,
      ingredients: tok.ingredients,
      cookware: tok.cookware,
      timers: tok.timers,
      section: currentSection,
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
  // row. Cookware and timers are always the full union — those appear
  // naturally in instructions, not in declaration blocks.
  const hasDeclarations = steps.some((s) => s.kind === 'declaration');
  const ingredientSource = hasDeclarations
    ? steps.filter((s) => s.kind === 'declaration').flatMap((s) => s.ingredients)
    : allIngredients;

  return {
    metadata,
    steps,
    ingredients: dedupeIngredients(ingredientSource),
    cookware: dedupeCookware(allCookware),
    timers: allTimers,
    sections,
  };
}

/**
 * Collapse duplicate ingredient rows into one, keeping the first qty/unit
 * pair we saw. We don't try to sum quantities across the same ingredient
 * — "1 cup flour" and "2 tbsp flour" are different amounts that a human
 * reader wants to see both of. The dedupe only merges rows that are
 * genuinely identical (same name, same qty, same unit).
 */
function dedupeIngredients(items: Ingredient[]): Ingredient[] {
  const seen = new Set<string>();
  const out: Ingredient[] = [];
  for (const it of items) {
    const key = `${it.name.toLowerCase()}|${it.qty ?? ''}|${it.unit ?? ''}`;
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

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Minimal HTML-entity escape for rendering user text into a trusted
 * container. We don't use DOMPurify here — the output has no user-
 * supplied HTML or URLs, just escaped text wrapped in our own tags —
 * but the caller is expected to insert the result into a component
 * that bounds the document tree.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatQtyUnit(qty: string | null, unit: string | null): string {
  if (qty && unit) return `${qty} ${unit}`;
  if (qty) return qty;
  if (unit) return unit;
  return '';
}

/**
 * Walk `steps` and bucket them by section, preserving the order
 * sections first appeared. The returned array always leads with the
 * implicit head bucket (`name: null`) when any unsectioned steps exist,
 * so callers can render it before the named sections.
 *
 * This is the pivot point that keeps two concerns separate: the parser
 * records only what the user wrote (a per-step section name); the
 * renderer decides how to present grouping. A future "flat even when
 * sections exist" toggle or a "sections only, ignore head bucket" mode
 * would live here, not in the parser.
 */
function groupStepsBySection(
  recipe: Recipe
): Array<{ name: string | null; steps: Step[] }> {
  const buckets = new Map<string | null, Step[]>();
  const order: Array<string | null> = [];
  for (const step of recipe.steps) {
    const key = step.section;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(step);
  }
  return order.map((name) => ({ name, steps: buckets.get(name)! }));
}

/**
 * Collect every ingredient that appears in the given steps, deduping
 * with the same `name|qty|unit` key the flat list uses. Extracted so
 * the section-aware renderer can apply the dedupe *within* a section
 * without cross-contaminating neighbouring sections — "1 cup flour" in
 * Soup and "1 cup flour" in Bread should both render once, in their
 * respective sub-lists.
 *
 * Mirrors the flat-level rule: if the bucket contains any declaration
 * lines, the section's ingredient list is authored (only declarations
 * count). Otherwise, all steps in the bucket contribute — same as the
 * pre-declaration behaviour. This prevents a mixed bucket from
 * double-counting a declared `@chicken{1%lb}` against an instruction's
 * `Add @chicken...` cross-reference.
 */
function dedupeFromSteps(steps: Step[]): Ingredient[] {
  const hasDeclarations = steps.some((s) => s.kind === 'declaration');
  const source = hasDeclarations ? steps.filter((s) => s.kind === 'declaration') : steps;
  const seen = new Set<string>();
  const out: Ingredient[] = [];
  for (const step of source) {
    for (const ing of step.ingredients) {
      const key = `${ing.name.toLowerCase()}|${ing.qty ?? ''}|${ing.unit ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ing);
    }
  }
  return out;
}

/**
 * Render an ingredient list as `<li>` markup — no surrounding `<ul>`,
 * so the caller controls whether this sits under a heading or inside
 * a sub-section block.
 */
function ingredientsListItems(ings: Ingredient[]): string {
  const out: string[] = [];
  for (const ing of ings) {
    const qty = formatQtyUnit(ing.qty, ing.unit);
    const qtyHtml = qty.length > 0 ? `<span class="cook-qty">${esc(qty)}</span> ` : '';
    out.push(`<li>${qtyHtml}<span class="cook-name">${esc(ing.name)}</span></li>`);
  }
  return out.join('');
}

/**
 * Render a parsed recipe as a self-contained HTML fragment. Class names
 * scoped with `cook-` prefix so a host page's stylesheet can reach in
 * without a wrapping selector. Structure:
 *
 *   <dl class="cook-metadata">…</dl>
 *   <h3>Ingredients</h3>
 *   [ <h4>Section</h4> ]?
 *   <ul class="cook-ingredients">…</ul>
 *   <h3>Cookware</h3>
 *   <ul class="cook-cookware">…</ul>
 *   <h3>Instructions</h3>
 *   [ <h4>Section</h4> ]?
 *   <ol class="cook-steps">…</ol>
 *
 * Sub-headings (`<h4>`) appear under both Ingredients and Instructions
 * only when the source used `== Name ==` or `# Name` headers. Absent
 * any headers, output collapses to the original flat layout so an
 * existing recipe with no sections renders identically to pre-sections
 * behaviour. Cookware stays flat regardless — the global dedupe is
 * what a cook wants, splitting pans across sections helps nobody.
 *
 * A block is omitted entirely when its list is empty, so a
 * freshly-typed metadata-only recipe doesn't render empty headers.
 */
export function recipeToHtml(recipe: Recipe): string {
  const out: string[] = [];

  const metaKeys = Object.keys(recipe.metadata);
  if (metaKeys.length > 0) {
    // Each dt/dd pair gets its own <div> so CSS can style them as
    // discrete chip-cards. HTML5 explicitly permits <div> children
    // inside <dl> for grouping; without this wrapper the <dt>/<dd>
    // siblings have no shared container to target.
    out.push('<dl class="cook-metadata">');
    for (const key of metaKeys) {
      out.push(
        `<div class="cook-meta-item"><dt>${esc(key)}</dt><dd>${esc(recipe.metadata[key]!)}</dd></div>`,
      );
    }
    out.push('</dl>');
  }

  const buckets = groupStepsBySection(recipe);
  const hasSections = recipe.sections.length > 0;
  // When declarations exist anywhere in the source, the ingredient
  // render is authored from declarations only. An instruction-only
  // bucket (e.g. the implicit head bucket after a dash-only reset that
  // holds the post-declaration prose) must NOT emit its own ingredient
  // sub-list — doing so would duplicate the declared names under a
  // leading un-named group.
  const hasDeclarations = recipe.steps.some((s) => s.kind === 'declaration');

  if (recipe.ingredients.length > 0) {
    out.push('<h3>Ingredients</h3>');
    if (!hasSections) {
      out.push('<ul class="cook-ingredients">');
      out.push(ingredientsListItems(recipe.ingredients));
      out.push('</ul>');
    } else {
      for (const bucket of buckets) {
        const bucketHasDeclarations = bucket.steps.some((s) => s.kind === 'declaration');
        if (hasDeclarations && !bucketHasDeclarations) continue;
        const ings = dedupeFromSteps(bucket.steps);
        if (ings.length === 0) continue;
        if (bucket.name !== null) {
          out.push(`<h4 class="cook-section">${esc(bucket.name)}</h4>`);
        }
        out.push('<ul class="cook-ingredients">');
        out.push(ingredientsListItems(ings));
        out.push('</ul>');
      }
    }
  }

  if (recipe.cookware.length > 0) {
    out.push('<h3>Cookware</h3>');
    out.push('<ul class="cook-cookware">');
    for (const cw of recipe.cookware) {
      out.push(`<li>${esc(cw.name)}</li>`);
    }
    out.push('</ul>');
  }

  // Only instruction-kind steps render in the Instructions block.
  // Declarations contributed their ingredients to the section-aware
  // Ingredients render above; their `text` is empty and their role in
  // the numbered instruction list is zero.
  const instructionSteps = recipe.steps.filter((s) => s.kind === 'instruction');
  if (instructionSteps.length > 0) {
    out.push('<h3>Instructions</h3>');
    if (!hasSections) {
      out.push('<ol class="cook-steps">');
      for (const step of instructionSteps) {
        out.push(`<li>${esc(step.text)}</li>`);
      }
      out.push('</ol>');
    } else {
      for (const bucket of buckets) {
        const bucketInstructions = bucket.steps.filter((s) => s.kind === 'instruction');
        if (bucketInstructions.length === 0) continue;
        if (bucket.name !== null) {
          out.push(`<h4 class="cook-section">${esc(bucket.name)}</h4>`);
        }
        // Each section gets its own `<ol>` so numbering restarts at 1
        // per section — that's how printed cookbooks lay out multi-part
        // recipes and what the reader expects when sections exist.
        out.push('<ol class="cook-steps">');
        for (const step of bucketInstructions) {
          out.push(`<li>${esc(step.text)}</li>`);
        }
        out.push('</ol>');
      }
    }
  }

  return out.join('');
}

/** Convenience wrapper: parse + render in one call. */
export function cooklangToHtml(src: string): string {
  return recipeToHtml(parseCooklang(src));
}

// ---------------------------------------------------------------------------
// Plain-text export (for AnyList and similar)
// ---------------------------------------------------------------------------

/**
 * Render a parsed recipe as a plain-text block the user can paste into
 * AnyList's manual-add text areas (or any other shopping-list app that
 * accepts "one item per line" ingredient lists).
 *
 * Shape:
 *
 *   Title
 *
 *   Ingredients
 *   - 1 cup flour
 *   - 2 eggs
 *
 *   Instructions
 *   == Soup ==
 *   1. …
 *   2. …
 *   == Finishing ==
 *   1. …
 *
 * Cookware is omitted — AnyList's shopping list doesn't track it, and
 * leaving it in produces a pasted list with unusable "saucepan" rows.
 *
 * Section headers appear only inside the Instructions block. The
 * ingredients block stays flat because AnyList treats every line in
 * the paste area as a buyable item — a stray "Finishing" row would
 * sit in the shopping list forever. Instructions are human-readable
 * prose, so section markers there are informational rather than
 * hazardous.
 */
export function recipeToPlainText(title: string, recipe: Recipe): string {
  const lines: string[] = [];
  if (title.trim().length > 0) {
    lines.push(title.trim(), '');
  }
  if (recipe.ingredients.length > 0) {
    lines.push('Ingredients');
    for (const ing of recipe.ingredients) {
      const qty = formatQtyUnit(ing.qty, ing.unit);
      lines.push(qty.length > 0 ? `- ${qty} ${ing.name}` : `- ${ing.name}`);
    }
    lines.push('');
  }
  // Declaration steps are filtered out — they contributed their
  // ingredients to the Ingredients block above and have no text to
  // number here. Same filter the HTML renderer uses so the two
  // outputs agree on step count and numbering.
  const instructionSteps = recipe.steps.filter((s) => s.kind === 'instruction');
  if (instructionSteps.length > 0) {
    lines.push('Instructions');
    if (recipe.sections.length === 0) {
      instructionSteps.forEach((step, i) => {
        lines.push(`${i + 1}. ${step.text}`);
      });
    } else {
      // Emit each bucket as its own numbered run so the renderer and
      // the plain-text export agree on "numbering restarts per
      // section". Head-bucket steps (section === null) print before
      // any `== Section ==` marker, matching the HTML layout.
      for (const bucket of groupStepsBySection(recipe)) {
        const bucketInstructions = bucket.steps.filter((s) => s.kind === 'instruction');
        if (bucketInstructions.length === 0) continue;
        if (bucket.name !== null) {
          lines.push(`== ${bucket.name} ==`);
        }
        bucketInstructions.forEach((step, i) => {
          lines.push(`${i + 1}. ${step.text}`);
        });
      }
    }
  }
  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Hard cap on a single recipe's source length. Not a spec limit — a
 * pragmatic ceiling that keeps the recipe_list tool's response under
 * context budget even with a few dozen recipes. A typical recipe is
 * 1-3 KiB of Cooklang; 20 KiB is headroom for a long multi-stage bread
 * recipe with extensive prose. Larger than that probably means the
 * LLM dumped prose into `cooklang` instead of parsing it to Cooklang —
 * rejecting is better than silently storing HTML.
 */
export const MAX_RECIPE_COOKLANG_CHARS = 20_000;

/** Title cap — mirrors memory label. */
export const MAX_RECIPE_TITLE_CHARS = 160;
