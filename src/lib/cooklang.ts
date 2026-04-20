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
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Strip `--` line comments and `[- … -]` block comments. Block
 * comments are handled first because a `--` that lives inside a block
 * comment must be ignored too. The spec allows block comments to span
 * lines, so this operates on the whole source at once.
 */
function stripComments(src: string): string {
  // Block comments: non-greedy, dot-matches-newline via `[\s\S]*?`.
  let out = src.replace(/\[-[\s\S]*?-\]/g, '');
  // Line comments: from `--` to end of line. Leave the newline so line
  // numbers (if we ever surface them in errors) stay intact.
  out = out.replace(/--[^\n]*/g, '');
  return out;
}

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
  const stripped = stripComments(src);
  const metadata: Record<string, string> = {};
  const steps: Step[] = [];
  const allIngredients: Ingredient[] = [];
  const allCookware: Cookware[] = [];
  const allTimers: Timer[] = [];

  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const meta = tryParseMetadata(line);
    if (meta) {
      metadata[meta.key] = meta.value;
      continue;
    }
    const tok = tokenizeLine(line);
    steps.push({
      text: tok.text,
      ingredients: tok.ingredients,
      cookware: tok.cookware,
      timers: tok.timers,
    });
    allIngredients.push(...tok.ingredients);
    allCookware.push(...tok.cookware);
    allTimers.push(...tok.timers);
  }

  return {
    metadata,
    steps,
    ingredients: dedupeIngredients(allIngredients),
    cookware: dedupeCookware(allCookware),
    timers: allTimers,
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
 * Render a parsed recipe as a self-contained HTML fragment. Class names
 * scoped with `cook-` prefix so a host page's stylesheet can reach in
 * without a wrapping selector. Structure:
 *
 *   <dl class="cook-metadata">…</dl>
 *   <h3>Ingredients</h3>
 *   <ul class="cook-ingredients">…</ul>
 *   <h3>Cookware</h3>
 *   <ul class="cook-cookware">…</ul>
 *   <h3>Instructions</h3>
 *   <ol class="cook-steps">…</ol>
 *
 * A section is omitted entirely when its list is empty, so a
 * freshly-typed metadata-only recipe doesn't render empty headers.
 */
export function recipeToHtml(recipe: Recipe): string {
  const out: string[] = [];

  const metaKeys = Object.keys(recipe.metadata);
  if (metaKeys.length > 0) {
    out.push('<dl class="cook-metadata">');
    for (const key of metaKeys) {
      out.push(`<dt>${esc(key)}</dt><dd>${esc(recipe.metadata[key]!)}</dd>`);
    }
    out.push('</dl>');
  }

  if (recipe.ingredients.length > 0) {
    out.push('<h3>Ingredients</h3>');
    out.push('<ul class="cook-ingredients">');
    for (const ing of recipe.ingredients) {
      const qty = formatQtyUnit(ing.qty, ing.unit);
      const qtyHtml = qty.length > 0 ? `<span class="cook-qty">${esc(qty)}</span> ` : '';
      out.push(`<li>${qtyHtml}<span class="cook-name">${esc(ing.name)}</span></li>`);
    }
    out.push('</ul>');
  }

  if (recipe.cookware.length > 0) {
    out.push('<h3>Cookware</h3>');
    out.push('<ul class="cook-cookware">');
    for (const cw of recipe.cookware) {
      out.push(`<li>${esc(cw.name)}</li>`);
    }
    out.push('</ul>');
  }

  if (recipe.steps.length > 0) {
    out.push('<h3>Instructions</h3>');
    out.push('<ol class="cook-steps">');
    for (const step of recipe.steps) {
      out.push(`<li>${esc(step.text)}</li>`);
    }
    out.push('</ol>');
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
 *   1. …
 *   2. …
 *
 * Cookware is omitted — AnyList's shopping list doesn't track it, and
 * leaving it in produces a pasted list with unusable "saucepan" rows.
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
  if (recipe.steps.length > 0) {
    lines.push('Instructions');
    recipe.steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step.text}`);
    });
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
