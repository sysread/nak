/**
 * Grocery auto-sectioning agent - the sub-completion that files a
 * just-created, unfiled product into one of the user's own store
 * sections. Callers (the panel's "Add (Auto)" action and the
 * Cookbook checkbox bridge) insert first and invoke this
 * fire-and-forget: the add stays instant, and the item hops out of
 * Other when the classification lands. The save is
 * `autoFileGroceryProduct`, which only touches rows still unfiled
 * (`section_source is null`), so a concurrent manual filing always
 * wins.
 *
 * Prompt shape: the user's sections as a numbered list, each with up
 * to a handful of example items (standalone filed products only -
 * recipe ingredients are poor evidence without their recipe), the
 * source recipe's title + cooklang when the add came from a recipe
 * (only the recipe disambiguates fresh vs. canned vs. frozen
 * "corn"), and the new names. The model answers a JSON object
 * mapping each name to a section number, 0 for "no good fit".
 *
 * Fail-closed everywhere: an unparseable answer, a truncated
 * completion (finish_reason 'length'), an out-of-range number, or a
 * transport error all leave the product unfiled in Other - exactly
 * where it would have been without the agent. Batch on purpose: an
 * "Add all" over N ingredients is ONE call, never N.
 *
 * Prompt assembly and answer parsing are pure functions, tested at
 * tests/grocery-section-agent.test.ts.
 */
import { agentModel } from './models';
import type { VeniceMessage } from './venice';
import type { GrocerySection, SupabaseService } from './supabase';
import { normalizeGroceryName } from './ui/grocery-list';
import { createLogger } from './logger.svelte';

const log = createLogger('grocery-section');

/**
 * Cap on example rows fetched for the prompt. Most-recently-updated
 * filed staples win server-side; buildSectionPromptGroups then caps
 * per section so one over-stuffed aisle cannot crowd out the rest.
 */
export const SECTION_EXAMPLE_FETCH_LIMIT = 80;

/** Max example item names shown per section in the prompt. */
export const SECTION_EXAMPLES_PER_SECTION = 6;

/**
 * Explicit output budget. The answer is a small JSON map (a few
 * tokens per name); thousands of headroom because an absent
 * max_completion_tokens makes the serving backend reserve its own
 * default budget out of the context window (see CLAUDE.md "Venice
 * sub-completions"). The call disables the thinking pass, so none of
 * this is spent on one.
 */
const CLASSIFY_MAX_TOKENS = 1024;

/**
 * Cap on the cooklang source included as recipe context. Recipes
 * are normally far smaller; the cap only guards a pathological
 * paste from bloating a classification prompt.
 */
const RECIPE_CONTEXT_MAX_CHARS = 6000;

export interface GrocerySectionExample {
  name: string;
  section_id: string;
}

export interface GroceryRecipeContext {
  title: string;
  cooklang: string;
}

/**
 * Group the example items under their sections in section order,
 * capped per section. Sections without examples still appear (the
 * section NAME alone is usually enough signal - "Frozen" needs no
 * examples to attract frozen corn).
 */
export function buildSectionPromptGroups(
  sections: readonly GrocerySection[],
  examples: readonly GrocerySectionExample[]
): Array<{ number: number; name: string; examples: string[] }> {
  const bySection = new Map<string, string[]>();
  for (const ex of examples) {
    const list = bySection.get(ex.section_id) ?? [];
    if (list.length < SECTION_EXAMPLES_PER_SECTION) list.push(ex.name);
    bySection.set(ex.section_id, list);
  }
  return sections.map((s, i) => ({
    number: i + 1,
    name: s.name,
    examples: bySection.get(s.id) ?? [],
  }));
}

/**
 * Assemble the classification messages. Single user turn - the task
 * restates itself fully each call, so there is no system/priming
 * split to maintain.
 */
export function buildClassifierMessages(args: {
  sections: readonly GrocerySection[];
  examples: readonly GrocerySectionExample[];
  names: readonly string[];
  recipe?: GroceryRecipeContext;
}): VeniceMessage[] {
  const groups = buildSectionPromptGroups(args.sections, args.examples);
  const lines: string[] = [];
  lines.push(
    'You are filing grocery items into the store sections a shopper',
    'has set up for themselves. Pick the single best section for',
    'each item, judging by how grocery stores are typically laid',
    'out and by the example items the shopper has already filed.',
    '',
    'Sections:'
  );
  for (const g of groups) {
    const ex =
      g.examples.length > 0 ? ` (examples: ${g.examples.join(', ')})` : '';
    lines.push(`${g.number}. ${g.name}${ex}`);
  }
  if (args.recipe) {
    lines.push(
      '',
      'The items are ingredients from this recipe - use it to',
      'disambiguate forms (fresh vs. canned vs. frozen, whole vs.',
      'ground, etc.):',
      '',
      `Recipe: ${args.recipe.title}`,
      args.recipe.cooklang.slice(0, RECIPE_CONTEXT_MAX_CHARS)
    );
  }
  lines.push(
    '',
    'Items to file:',
    ...args.names.map((n) => `- ${n}`),
    '',
    'Answer with ONLY a JSON object mapping each item name (exactly',
    'as written above) to its section number. Use 0 when no section',
    'fits well.'
  );
  return [{ role: 'user', content: lines.join('\n') }];
}

/**
 * Parse the model's JSON answer into name -> section id. Tolerant of
 * number-as-string values and of name-key casing/whitespace drift
 * (keys match by normalized name). Anything else - a missing name,
 * a 0, an out-of-range or non-integer number - simply drops that
 * name, leaving its product unfiled.
 */
export function parseClassifierAnswer(
  content: string,
  names: readonly string[],
  sections: readonly GrocerySection[]
): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return new Map();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Map();
  }
  const byKey = new Map<string, unknown>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    byKey.set(normalizeGroceryName(k), v);
  }
  const out = new Map<string, string>();
  for (const name of names) {
    const raw = byKey.get(normalizeGroceryName(name));
    const num = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof num !== 'number' || !Number.isInteger(num)) continue;
    const section = sections[num - 1];
    if (num < 1 || !section) continue;
    out.set(normalizeGroceryName(name), section.id);
  }
  return out;
}

/**
 * Run one classification: fetch sections + examples, call the
 * grocerySection model, and return normalized-name -> section id for
 * every name the model confidently placed. Empty map on any failure
 * (fail closed - the products stay in Other).
 */
export async function classifyGrocerySections(
  supabase: SupabaseService,
  args: { names: readonly string[]; recipe?: GroceryRecipeContext }
): Promise<Map<string, string>> {
  if (args.names.length === 0) return new Map();
  try {
    const [sections, examples] = await Promise.all([
      supabase.listGrocerySections(),
      supabase.listSectionExampleProducts(SECTION_EXAMPLE_FETCH_LIMIT),
    ]);
    if (sections.length === 0) return new Map();
    const completion = await supabase.complete({
      model: agentModel('grocerySection').id,
      messages: buildClassifierMessages({
        sections,
        examples,
        names: args.names,
        recipe: args.recipe,
      }),
      // Deterministic-ish filing; sampling variety has no value here.
      temperature: 0,
      // Pure classification over evidence already in context - the
      // model can reason, and its default effort is high, so this
      // suppression is load-bearing (an unpinned call burns the JSON
      // budget on a thinking pass).
      disableThinking: true,
      maxTokens: CLASSIFY_MAX_TOKENS,
      responseFormat: { type: 'json_object' },
    });
    // A truncated answer is not a valid empty verdict - fail closed
    // rather than parse half a JSON object.
    if (completion.finishReason === 'length') {
      log.warn('classifier hit the output budget; leaving items unfiled');
      return new Map();
    }
    return parseClassifierAnswer(completion.text ?? '', args.names, sections);
  } catch (err) {
    log.warn('classification failed; leaving items unfiled', err);
    return new Map();
  }
}

/**
 * The fire-and-forget entry every add path uses: classify the given
 * products (in ONE call) and file each confidently-placed one that
 * is still unfiled. Returns true when at least one product was
 * filed, so the caller knows a refresh is worth it. Never throws.
 */
export async function autoFileProducts(
  supabase: SupabaseService,
  products: ReadonlyArray<{ id: string; name: string }>,
  recipe?: GroceryRecipeContext
): Promise<boolean> {
  const choices = await classifyGrocerySections(supabase, {
    names: products.map((p) => p.name),
    recipe,
  });
  if (choices.size === 0) return false;
  let filed = false;
  for (const p of products) {
    const sectionId = choices.get(normalizeGroceryName(p.name));
    if (!sectionId) continue;
    try {
      await supabase.autoFileGroceryProduct(p.id, sectionId);
      filed = true;
    } catch (err) {
      // Per-product save failures leave that product in Other; the
      // rest of the batch still files.
      log.warn(`auto-file failed for ${p.name}`, err);
    }
  }
  return filed;
}
