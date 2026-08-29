/**
 * Cooklang recipe renderers - the three projections of a parsed
 * {@link Recipe} AST: HTML (for the in-app detail pane), plain text
 * (for pasting into AnyList), and Markdown (for Obsidian / Notion /
 * GitHub). The parser that builds the AST lives in `./cooklang`;
 * this module imports its types and `parseCooklang` for the
 * parse-plus-render convenience wrapper.
 *
 * The three renderers are parallel projections: each walks the same
 * AST and emits a different surface. Section grouping, ingredient
 * dedupe, and the declaration-vs-instruction split are shared by all
 * three (via `groupStepsBySection` and `dedupeFromSteps`), so a
 * change to the parser's section or declaration semantics reaches
 * every renderer through one code path.
 *
 * Section depth: the parser records how deep a `==` header is (the
 * count of `=` signs). The HTML and Markdown renderers use that depth
 * to pick a heading level so nested sub-sections nest visually:
 * depth 2 (`==`) -> h4 / `###`, depth 3 (`===`) -> h5 / `####`,
 * depth 4 (`====`) -> h6 / `#####`, capped at h6 / `######`.
 */

import { parseCooklang } from './cooklang';
import type { Recipe, Step, Ingredient, Timer } from './cooklang';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A timer paired with the step text it appeared in, so the Timers
 * list can show context for anonymous timers. Built from
 * {@link Recipe.steps} by {@link collectTimersWithContext}.
 */
interface TimerWithContext {
  timer: Timer;
  /** Step text for anonymous timers; null for named timers (the name IS the context). */
  stepText: string | null;
}

/**
 * Walk the recipe steps and collect every time-unit timer, paired
 * with the text of the step it appeared in. Deduplicates by
 * (name, duration, unit) - same key the parser's dedupeTimers uses.
 *
 * Named timers carry their name as context, so stepText is null.
 * Anonymous timers carry the step text so the renderer can show
 * "what was this timer for?" without the cook having to scan the
 * instructions.
 */
function collectTimersWithContext(recipe: Recipe): TimerWithContext[] {
  const seen = new Set<string>();
  const out: TimerWithContext[] = [];
  for (const step of recipe.steps) {
    for (const timer of step.timers) {
      if (!isTimeTimer(timer)) continue;
      const key = `${timer.name ?? ''}|${timer.duration}|${timer.unit ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        timer,
        stepText: timer.name ? null : step.text,
      });
    }
  }
  return out;
}

/**
 * Minimal HTML-entity escape for rendering user text into a trusted
 * container. We don't use DOMPurify here - the output has no user-
 * supplied HTML or URLs, just escaped text wrapped in our own tags -
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

/**
 * Narrow inline-emphasis pass for step text. Runs AFTER `esc()`, so
 * the input has already had HTML entities escaped; we only introduce
 * the small set of tags below. NOT a markdown renderer - no links,
 * code spans, headings, lists, line-break handling. Scope is the
 * inline styles the LLM reaches for when writing prose:
 *
 *   **bold**          -> <strong>bold</strong>
 *   *italic*          -> <em>italic</em>
 *   _italic_          -> <em>italic</em>   (word-boundary guarded)
 *
 * Why hand-roll this instead of pulling in marked / markdown-it:
 *   - The cookbook view doesn't want a general markdown surface (it
 *     would invite tables, raw HTML, link injection, and a security
 *     review). The three patterns here cover the LLM's actual habits
 *     without the rest.
 *   - The step-text output is already HTML-escaped; tacking three
 *     regex substitutions on the back is cheaper and clearer than
 *     wiring a parser to "no, only these".
 *
 * Ordering matters: bold runs first so `**X**` is consumed before the
 * italic-asterisk pass would see the inner `*`s. Underscore italic is
 * guarded by non-word lookbehind/lookahead so `pre_minced` (a single
 * word with an internal `_`) does not match - CommonMark behaves the
 * same way for the same reason.
 */
function renderInlineEmphasis(escaped: string): string {
  let out = escaped;
  // `**bold**`: two asterisks, at least one non-asterisk non-newline
  // char, two asterisks. Non-greedy body so `**a** **b**` stays as
  // two distinct spans rather than one giant one.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  // `*italic*`: single asterisks with no asterisk inside. Same shape;
  // a sequence the bold pass already consumed can't reappear here.
  out = out.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  // `_italic_`: underscores with word boundaries on both sides. The
  // `(^|[^\w])` group captures the boundary char so we can re-emit
  // it; the trailing `(?=[^\w]|$)` is a lookahead so we don't consume
  // (and lose) the boundary on the right side.
  out = out.replace(/(^|[^\w])_([^_\n]+?)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  return out;
}

function formatQtyUnit(qty: string | null, unit: string | null): string {
  if (qty && unit) return `${qty} ${unit}`;
  if (qty) return qty;
  if (unit) return unit;
  return '';
}

/**
 * Format a timer as a single human-readable string: `name: duration
 * unit` when the timer is named, or `duration unit` when anonymous.
 * Mirrors the inline replacement the parser already does in step text,
 * so the standalone Timers list reads the same as the prose mention.
 */
function formatTimer(timer: Timer): string {
  const du = formatQtyUnit(timer.duration, timer.unit);
  return timer.name ? `${timer.name}: ${du}` : du;
}

/**
 * Cooklang timer syntax (`~{value%unit}`) accepts any unit string.
 * Some recipes use it for non-time measurements (e.g. `~{6,000%ft}`
 * for altitude). The Timers list should only show actual durations,
 * so filter to recognized time units.
 */
const TIME_UNITS = new Set([
  'sec', 'secs', 'second', 'seconds', 's',
  'min', 'mins', 'minute', 'minutes', 'm',
  'hr', 'hrs', 'hour', 'hours', 'h',
  'day', 'days', 'd',
  'week', 'weeks', 'w',
  'month', 'months',
  'year', 'years',
]);

function isTimeTimer(timer: Timer): boolean {
  if (!timer.unit) return false;
  return TIME_UNITS.has(timer.unit.toLowerCase());
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
 * Depth of a section bucket, read from the first step that carries the
 * section's name. The parser stamps every step with the depth of the
 * `==` header that opened its section (or 2 for `#`-style headers);
 * we take the first step's value so a section re-opened at a different
 * depth uses the depth from its first appearance.
 *
 * Falls back to 2 (the `==` / `#` default) when the bucket's steps
 * carry no depth - e.g. a head bucket with a stale null depth. The
 * head bucket (`name === null`) never renders a heading, so the
 * fallback is inert there.
 */
function bucketDepth(steps: Step[]): number {
  return steps[0]?.sectionDepth ?? 2;
}

/** HTML heading tag for a section bucket: depth 2 -> h4, 3 -> h5, 4 -> h6, capped at h6. */
function sectionHtmlTag(steps: Step[]): string {
  return `h${Math.min(bucketDepth(steps) + 2, 6)}`;
}

/** Markdown heading prefix for a section bucket: depth 2 -> ###, 3 -> ####, 4 -> #####, capped at ######. */
function sectionMarkdownPrefix(steps: Step[]): string {
  return '#'.repeat(Math.min(bucketDepth(steps) + 1, 6));
}

/**
 * Collect every ingredient that appears in the given steps, deduping
 * with the same `name|qty|unit|optional` key the flat list uses. Extracted so
 * the section-aware renderer can apply the dedupe *within* a section
 * without cross-contaminating neighbouring sections - "1 cup flour" in
 * Soup and "1 cup flour" in Bread should both render once, in their
 * respective sub-lists.
 *
 * Mirrors the flat-level rule: if the bucket contains any declaration
 * lines, the section's ingredient list is authored (only declarations
 * count). Otherwise, all steps in the bucket contribute - same as the
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
      const key = `${ing.name.toLowerCase()}|${ing.qty ?? ''}|${ing.unit ?? ''}|${ing.optional ? '?' : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ing);
    }
  }
  return out;
}

/**
 * Accessible label for a grocery checkbox ingredient row. Shared with
 * the Cookbook detail pane's sync effect, which RESTORES this label
 * when cooking mode (which swaps it for the used-ingredient verb)
 * ends - keeping the wording in one place stops the renderer and the
 * sync effect from drifting apart.
 */
export function groceryCheckboxAriaLabel(name: string): string {
  return `Add ${name} to grocery list`;
}

/**
 * Render an ingredient list as `<li>` markup - no surrounding `<ul>`,
 * so the caller controls whether this sits under a heading or inside
 * a sub-section block.
 *
 * With `checkboxes` on, each row becomes a `<label>` wrapping an
 * `<input type="checkbox" class="cook-buy" data-ing="<name>">` plus
 * the row text, so tapping ANYWHERE on the row - checkbox or
 * ingredient label - toggles it (native label semantics; the input
 * still fires `change`, which is what the host's delegation
 * listens for). The renderer stays grocery-unaware on purpose: it
 * stamps the RAW ingredient name and never any checked state - the
 * host (the Cookbook detail pane) owns matching names against
 * grocery rows, syncing `checked` after mount, and handling changes
 * via delegation. The same ingredient name appearing in several
 * rows gets the same data-ing value; the host treats those as one
 * toggle.
 */
function ingredientsListItems(ings: Ingredient[], checkboxes: boolean): string {
  const out: string[] = [];
  for (const ing of ings) {
    const qty = formatQtyUnit(ing.qty, ing.unit);
    const qtyHtml = qty.length > 0 ? `<span class="cook-qty">${esc(qty)}</span> ` : '';
    const optHtml = ing.optional ? ' <span class="cook-optional">(optional)</span>' : '';
    const noteHtml = ing.note
      ? ` <span class="cook-note">${esc(ing.note)}</span>`
      : '';
    if (checkboxes) {
      const checkboxHtml = `<input type="checkbox" class="cook-buy" data-ing="${esc(ing.name)}" aria-label="${esc(groceryCheckboxAriaLabel(ing.name))}"> `;
      out.push(
        `<li><label class="cook-buy-label">${checkboxHtml}${qtyHtml}<span class="cook-name">${esc(ing.name)}</span>${optHtml}${noteHtml}</label></li>`
      );
    } else {
      out.push(
        `<li>${qtyHtml}<span class="cook-name">${esc(ing.name)}</span>${optHtml}${noteHtml}</li>`
      );
    }
  }
  return out.join('');
}

/**
 * One `- qty name` bullet for an ingredient, shared by the plain-text
 * and markdown exports. The "(optional)" suffix mirrors the HTML
 * renderer's cook-optional tag so all three projections agree on how
 * an `@?ingredient` reads.
 */
function ingredientBulletLine(ing: Ingredient): string {
  const qty = formatQtyUnit(ing.qty, ing.unit);
  const name = ing.optional ? `${ing.name} (optional)` : ing.name;
  const base = qty.length > 0 ? `- ${qty} ${name}` : `- ${name}`;
  return ing.note ? `${base} — ${ing.note}` : base;
}

// ---------------------------------------------------------------------------
// TOC helpers
// ---------------------------------------------------------------------------

// Four blocks carry a navigable table-of-contents entry: Ingredients,
// Cookware, Timers, and Instructions. Cookware and Timers are flat
// (no section sub-entries), so their TOC entries have no sections.
type TocBlock = 'ingredients' | 'cookware' | 'timers' | 'instructions';

/**
 * Anchor id for a recipe heading. Shared by `recipeToHtml` (which stamps
 * it on the `<h3>` / `<h4>`) and `recipeToc` (which points the jump link
 * at it), so the link target can never drift from the heading it scrolls
 * to - change the scheme here and both projections move together.
 *
 * Section sub-headings are keyed by their INDEX in `recipe.sections`, not
 * by a name slug: two section names that would slugify the same can't
 * collide, and the same section name appearing under BOTH Ingredients and
 * Instructions gets a distinct id per block (`cook-ingredients-s0` vs
 * `cook-instructions-s0`), so a duplicate id never lands in the document.
 */
function tocHeadingId(block: TocBlock, sectionIndex: number | null): string {
  return sectionIndex === null ? `cook-${block}` : `cook-${block}-s${sectionIndex}`;
}

/**
 * Whether a section bucket emits its own ingredient sub-list in the
 * Ingredients block. Mirrors the flat-level declaration rule: when the
 * recipe uses declarations anywhere, only buckets that themselves hold
 * declarations contribute (an instruction-only head bucket would
 * otherwise duplicate the declared rows under an un-named group); a
 * bucket whose deduped ingredient list is empty renders nothing.
 *
 * Shared by `recipeToHtml` and `recipeToc` so the rendered `<h4>` set and
 * the TOC sub-entries stay in lockstep.
 */
function ingredientBucketRenders(steps: Step[], hasDeclarations: boolean): boolean {
  const bucketHasDeclarations = steps.some((s) => s.kind === 'declaration');
  if (hasDeclarations && !bucketHasDeclarations) return false;
  return dedupeFromSteps(steps).length > 0;
}

/**
 * Whether a section bucket emits an instruction `<ol>` (and thus an
 * `<h4>`) in the Instructions block: it does when the bucket holds at
 * least one instruction-kind step. Shared by `recipeToHtml` and
 * `recipeToc`.
 */
function instructionBucketRenders(steps: Step[]): boolean {
  return steps.some((s) => s.kind === 'instruction');
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

/**
 * Render a parsed recipe as a self-contained HTML fragment. Class names
 * scoped with `cook-` prefix so a host page's stylesheet can reach in
 * without a wrapping selector. Structure:
 *
 *   <dl class="cook-metadata">...</dl>
 *   <h3 id="cook-ingredients">Ingredients</h3>
 *   [ <h4/h5/h6 id="cook-ingredients-sN">Section</h4> ]?
 *   <ul class="cook-ingredients">...</ul>
 *   <h3>Cookware</h3>
 *   <ul class="cook-cookware">...</ul>
 *   <h3>Timers</h3>
 *   <ul class="cook-timers">...</ul>
 *   <h3 id="cook-instructions">Instructions</h3>
 *   [ <h4/h5/h6 id="cook-instructions-sN">Section</h4> ]?
 *   <ol class="cook-steps">...</ol>
 *
 * Sub-headings (`<h4>` through `<h6>`) appear under both Ingredients and
 * Instructions only when the source used `== Name ==` or `# Name`
 * headers. The heading level tracks the section depth: `==` (depth 2)
 * renders as `<h4>`, `===` (depth 3) as `<h5>`, `====` (depth 4) as
 * `<h6>`. Absent any headers, output collapses to the original flat
 * layout so an existing recipe with no sections renders identically to
 * pre-sections behaviour. Cookware and Timers stay flat regardless - the
 * global dedupe is what a cook wants, splitting pans or timers across
 * sections helps nobody.
 *
 * The Ingredients / Instructions headings carry `id`s (via `tocHeadingId`)
 * so the detail pane's table of contents can scroll to them; Cookware and
 * Timers are not TOC targets and stay id-less. A block is omitted
 * entirely when its list is empty, so a freshly-typed metadata-only
 * recipe doesn't render empty headers.
 */
export interface RecipeHtmlOptions {
  /**
   * Prefix every ingredient row with a grocery checkbox (see
   * `ingredientsListItems`). Off by default; the Cookbook detail pane
   * turns it on for the live recipe view (past-version views and the
   * edit preview stay checkbox-free).
   */
  ingredientCheckboxes?: boolean;
}

export function recipeToHtml(recipe: Recipe, opts: RecipeHtmlOptions = {}): string {
  const checkboxes = opts.ingredientCheckboxes === true;
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
  // sub-list - doing so would duplicate the declared names under a
  // leading un-named group.
  const hasDeclarations = recipe.steps.some((s) => s.kind === 'declaration');

  if (recipe.ingredients.length > 0) {
    out.push(`<h3 id="${tocHeadingId('ingredients', null)}">Ingredients</h3>`);
    if (!hasSections) {
      out.push('<ul class="cook-ingredients">');
      out.push(ingredientsListItems(recipe.ingredients, checkboxes));
      out.push('</ul>');
    } else {
      for (const bucket of buckets) {
        if (!ingredientBucketRenders(bucket.steps, hasDeclarations)) continue;
        const ings = dedupeFromSteps(bucket.steps);
        if (bucket.name !== null) {
          const id = tocHeadingId('ingredients', recipe.sections.indexOf(bucket.name));
          const tag = sectionHtmlTag(bucket.steps);
          out.push(`<${tag} class="cook-section" id="${id}">${esc(bucket.name)}</${tag}>`);
        }
        out.push('<ul class="cook-ingredients">');
        out.push(ingredientsListItems(ings, checkboxes));
        out.push('</ul>');
      }
    }
  }

  if (recipe.cookware.length > 0) {
    out.push(`<h3 id="${tocHeadingId('cookware', null)}">Cookware</h3>`);
    out.push('<ul class="cook-cookware">');
    for (const cw of recipe.cookware) {
      out.push(`<li>${esc(cw.name)}</li>`);
    }
    out.push('</ul>');
  }

  const timersWithContext = collectTimersWithContext(recipe);
  if (timersWithContext.length > 0) {
    out.push(`<h3 id="${tocHeadingId('timers', null)}">Timers</h3>`);
    out.push('<ul class="cook-timers">');
    for (const { timer, stepText } of timersWithContext) {
      const du = esc(formatTimer(timer));
      if (stepText) {
        // Anonymous timer: show the duration, then the step text
        // as a muted fade-out line so the cook knows what it's for.
        out.push(
          `<li><span class="cook-timer-duration">${du}</span>` +
            `<span class="cook-timer-context">${esc(stepText)}</span></li>`,
        );
      } else {
        // Named timer: the name is the context.
        out.push(`<li>${du}</li>`);
      }
    }
    out.push('</ul>');
  }

  // Only instruction-kind steps render in the Instructions block.
  // Declarations contributed their ingredients to the section-aware
  // Ingredients render above; their `text` is empty and their role in
  // the numbered instruction list is zero.
  const instructionSteps = recipe.steps.filter((s) => s.kind === 'instruction');
  if (instructionSteps.length > 0) {
    out.push(`<h3 id="${tocHeadingId('instructions', null)}">Instructions</h3>`);
    if (!hasSections) {
      out.push('<ol class="cook-steps">');
      for (const step of instructionSteps) {
        out.push(`<li>${renderInlineEmphasis(esc(step.text))}</li>`);
      }
      out.push('</ol>');
    } else {
      for (const bucket of buckets) {
        const bucketInstructions = bucket.steps.filter((s) => s.kind === 'instruction');
        if (bucketInstructions.length === 0) continue;
        if (bucket.name !== null) {
          const id = tocHeadingId('instructions', recipe.sections.indexOf(bucket.name));
          const tag = sectionHtmlTag(bucket.steps);
          out.push(`<${tag} class="cook-section" id="${id}">${esc(bucket.name)}</${tag}>`);
        }
        // Each section gets its own `<ol>` so numbering restarts at 1
        // per section - that's how printed cookbooks lay out multi-part
        // recipes and what the reader expects when sections exist.
        out.push('<ol class="cook-steps">');
        for (const step of bucketInstructions) {
          out.push(`<li>${renderInlineEmphasis(esc(step.text))}</li>`);
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
// Table of contents
// ---------------------------------------------------------------------------

/** A section sub-entry inside a top-level TOC block. `id` matches the
 *  `<h4>` anchor `recipeToHtml` stamps; `label` is the section name. */
export interface RecipeTocSection {
  id: string;
  label: string;
}

/** A top-level TOC entry (Ingredients or Instructions). `id` matches the
 *  block's `<h3>` anchor; `sections` are the per-section sub-entries, in
 *  source order, empty when the recipe has no sections in this block. */
export interface RecipeTocEntry {
  id: string;
  label: string;
  sections: RecipeTocSection[];
}

/**
 * Project a parsed recipe into a navigable table of contents: the
 * Ingredients and Instructions blocks as top-level entries, each with a
 * sub-entry per section heading the renderer emits. A third projection
 * of the same AST as `recipeToHtml`, kept in lockstep with it by sharing
 * `tocHeadingId` (the link targets) and the `ingredientBucketRenders` /
 * `instructionBucketRenders` predicates (which sections actually render).
 *
 * Cookware and Timers are deliberately absent - they render as flat
 * asides between the blocks, not as places a reader navigates to. A
 * block is omitted entirely when it has no content, matching the
 * renderer's "skip empty blocks" rule, so a metadata-only draft produces
 * an empty TOC.
 */
export function recipeToc(recipe: Recipe): RecipeTocEntry[] {
  const entries: RecipeTocEntry[] = [];
  const buckets = groupStepsBySection(recipe);
  const hasSections = recipe.sections.length > 0;
  const hasDeclarations = recipe.steps.some((s) => s.kind === 'declaration');

  if (recipe.ingredients.length > 0) {
    const sections: RecipeTocSection[] = [];
    if (hasSections) {
      for (const bucket of buckets) {
        if (bucket.name === null) continue;
        if (!ingredientBucketRenders(bucket.steps, hasDeclarations)) continue;
        sections.push({
          id: tocHeadingId('ingredients', recipe.sections.indexOf(bucket.name)),
          label: bucket.name,
        });
      }
    }
    entries.push({ id: tocHeadingId('ingredients', null), label: 'Ingredients', sections });
  }

  // Cookware and Timers are flat blocks (no section sub-entries).
  // They appear in the TOC as simple jump links when non-empty,
  // between Ingredients and Instructions to match the HTML order.
  if (recipe.cookware.length > 0) {
    entries.push({ id: tocHeadingId('cookware', null), label: 'Cookware', sections: [] });
  }

  if (collectTimersWithContext(recipe).length > 0) {
    entries.push({ id: tocHeadingId('timers', null), label: 'Timers', sections: [] });
  }

  const instructionSteps = recipe.steps.filter((s) => s.kind === 'instruction');
  if (instructionSteps.length > 0) {
    const sections: RecipeTocSection[] = [];
    if (hasSections) {
      for (const bucket of buckets) {
        if (bucket.name === null) continue;
        if (!instructionBucketRenders(bucket.steps)) continue;
        sections.push({
          id: tocHeadingId('instructions', recipe.sections.indexOf(bucket.name)),
          label: bucket.name,
        });
      }
    }
    entries.push({ id: tocHeadingId('instructions', null), label: 'Instructions', sections });
  }

  return entries;
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
 *   1. ...
 *   2. ...
 *   == Finishing ==
 *   1. ...
 *
 * Cookware and Timers are omitted - AnyList's shopping list doesn't
 * track either, and leaving them in produces a pasted list with
 * unusable "saucepan" or "30 minutes" rows.
 *
 * Section headers appear only inside the Instructions block. The
 * ingredients block stays flat because AnyList treats every line in
 * the paste area as a buyable item - a stray "Finishing" row would
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
      lines.push(ingredientBulletLine(ing));
    }
    lines.push('');
  }
  // Declaration steps are filtered out - they contributed their
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
// Markdown export (for pasting into Obsidian / Notion / a GitHub issue)
// ---------------------------------------------------------------------------

/**
 * Render a parsed recipe as a Markdown document the user can paste into
 * any markdown-aware app (notes apps, issue trackers, journals). Sibling
 * to `recipeToPlainText` but aimed at a different transfer target -
 * plain text is the AnyList path (one-item-per-line ingredients,
 * cookware and timers stripped), markdown is the human-readable path
 * (full structure, cookware and timers included, source link
 * clickable).
 *
 * Shape:
 *
 *   # Title
 *
 *   *Source: [Name](url)*
 *
 *   - **servings**: 4
 *   - **prep_time**: 20 min
 *
 *   ## Ingredients
 *   - 200 g flour
 *   - 2 eggs
 *
 *   ### Section (when sections exist, depth 2)
 *   - ...
 *
 *   ## Cookware
 *   - bowl
 *
 *   ## Timers
 *   - 30 minutes
 *
 *   ## Instructions
 *   1. Step one.
 *   2. Step two.
 *
 *   ### Section (when sections exist, depth 2)
 *   1. ...
 *
 * Section sub-headings track the source's `==` depth: depth 2 renders
 * as `###`, depth 3 as `####`, depth 4 as `#####`, capped at `######`.
 *
 * Pass-through for inline markdown: step text, ingredient names,
 * metadata values, and the title are emitted verbatim. The LLM
 * occasionally drops markdown emphasis (`**bold**`, backticks) into a
 * recipe and the user wants that to round-trip - escaping the special
 * chars would mangle the writer's intent. Structural markdown
 * (headings, list markers, link syntax) is ours to author; content
 * markdown is the recipe's.
 */
export function recipeToMarkdown(
  title: string,
  recipe: Recipe,
  options: { source?: string | null; sourceUrl?: string | null } = {},
): string {
  const lines: string[] = [];

  if (title.trim().length > 0) {
    lines.push(`# ${title.trim()}`, '');
  }

  // Source attribution. Prefer a named link when both pieces are
  // present, fall back to the URL alone (rendered as an auto-link via
  // angle brackets so CommonMark and GFM both make it clickable), or
  // the source name alone when there's no URL to point at. Wrapped in
  // italics so it reads as a byline rather than body content.
  const source = options.source?.trim() ?? '';
  const sourceUrl = options.sourceUrl?.trim() ?? '';
  if (source && sourceUrl) {
    lines.push(`*Source: [${source}](${sourceUrl})*`, '');
  } else if (sourceUrl) {
    lines.push(`*Source: <${sourceUrl}>*`, '');
  } else if (source) {
    lines.push(`*Source: ${source}*`, '');
  }

  // `>> key: value` metadata as a bulleted list. Keys are bolded so the
  // block reads as labelled facts (servings, prep_time, yield, etc.)
  // rather than a wall of colons. Insertion order is preserved by
  // Object.keys on a plain object in modern engines.
  const metaKeys = Object.keys(recipe.metadata);
  if (metaKeys.length > 0) {
    for (const key of metaKeys) {
      lines.push(`- **${key}**: ${recipe.metadata[key]}`);
    }
    lines.push('');
  }

  if (recipe.ingredients.length > 0) {
    lines.push('## Ingredients', '');
    if (recipe.sections.length === 0) {
      for (const ing of recipe.ingredients) {
        lines.push(ingredientBulletLine(ing));
      }
      lines.push('');
    } else {
      // Mirror the HTML renderer's per-section ingredient grouping:
      // when declaration lines exist, only buckets containing
      // declarations get their own ingredient sub-list; otherwise
      // every bucket contributes via cross-references in its steps.
      const hasDeclarations = recipe.steps.some((s) => s.kind === 'declaration');
      for (const bucket of groupStepsBySection(recipe)) {
        const bucketHasDeclarations = bucket.steps.some((s) => s.kind === 'declaration');
        if (hasDeclarations && !bucketHasDeclarations) continue;
        const ings = dedupeFromSteps(bucket.steps);
        if (ings.length === 0) continue;
        if (bucket.name !== null) {
          const prefix = sectionMarkdownPrefix(bucket.steps);
          lines.push(`${prefix} ${bucket.name}`, '');
        }
        for (const ing of ings) {
          lines.push(ingredientBulletLine(ing));
        }
        lines.push('');
      }
    }
  }

  // Unlike the plain-text export we DO include cookware - the markdown
  // target is a human-readable doc, not a shopping list, so "what
  // tools do I need" is useful prep info. Stays flat (no section
  // grouping) for the same reason the HTML renderer does: pan-by-
  // section helps nobody.
  if (recipe.cookware.length > 0) {
    lines.push('## Cookware', '');
    for (const cw of recipe.cookware) {
      lines.push(`- ${cw.name}`);
    }
    lines.push('');
  }

  // Timers - same flat treatment as cookware. The markdown target is a
  // human-readable doc, so a glance at "how long does this step take"
  // is useful prep info. Named timers show `name: duration unit`;
  // anonymous timers show `duration unit` followed by the step text
  // in parentheses so the context survives the copy-paste. Filtered
  // to time units only.
  const mdTimers = collectTimersWithContext(recipe);
  if (mdTimers.length > 0) {
    lines.push('## Timers', '');
    for (const { timer, stepText } of mdTimers) {
      const du = formatTimer(timer);
      if (stepText) {
        // Truncate step text for the markdown target - no fade-out
        // CSS here, so cap at a reasonable length.
        const ctx = stepText.length > 80 ? stepText.slice(0, 77) + '...' : stepText;
        lines.push(`- ${du} (${ctx})`);
      } else {
        lines.push(`- ${du}`);
      }
    }
    lines.push('');
  }

  // Declaration steps are filtered out - they contributed their
  // ingredients to the Ingredients block and have no text to number.
  // Same filter the HTML and plain-text renderers use so all three
  // outputs agree on which lines count as instructions.
  const instructionSteps = recipe.steps.filter((s) => s.kind === 'instruction');
  if (instructionSteps.length > 0) {
    lines.push('## Instructions', '');
    if (recipe.sections.length === 0) {
      instructionSteps.forEach((step, i) => {
        lines.push(`${i + 1}. ${step.text}`);
      });
    } else {
      for (const bucket of groupStepsBySection(recipe)) {
        const bucketInstructions = bucket.steps.filter((s) => s.kind === 'instruction');
        if (bucketInstructions.length === 0) continue;
        if (bucket.name !== null) {
          const prefix = sectionMarkdownPrefix(bucket.steps);
          lines.push(`${prefix} ${bucket.name}`, '');
        }
        bucketInstructions.forEach((step, i) => {
          lines.push(`${i + 1}. ${step.text}`);
        });
        lines.push('');
      }
    }
  }

  return lines.join('\n').trimEnd();
}
