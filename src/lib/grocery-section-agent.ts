/**
 * Grocery auto-sectioning agent - the decision-model call that files a
 * just-created, unfiled product into one of the user's own store
 * sections. Callers (the panel's "Add (Auto)" action and the
 * Cookbook checkbox bridge) insert first and invoke this
 * fire-and-forget: the add stays instant, and the item hops out of
 * Other when the classification lands. The save is
 * `autoFileGroceryProduct`, which only touches rows still unfiled
 * (`section_source is null`), so a concurrent manual filing always
 * wins.
 *
 * Decision shape (beta Venice Decisions API, model `clef-api` - the
 * private tier, per docs/dev/plans/venice-decisions-plan.md D1): the
 * state carries the user's sections with filed examples, the source
 * recipe's title + cooklang when the add came from a recipe (only
 * the recipe disambiguates fresh vs. canned vs. frozen "corn"), and
 * the item names. One `choice` question per item picks a section by
 * name or the `none` option; each answer carries the full
 * probability distribution plus a confidence value. No prose and no
 * JSON repair - the failure modes the chat-completion path guarded
 * (unparseable answer, truncated completion) collapse to the
 * typed-answer coercion in parseDecisionAnswers.
 *
 * Fail-closed everywhere: a missing answer, an unknown section
 * name, the `none` pick, or a transport error all leave the product
 * unfiled in Other - exactly where it would have been without the
 * agent. Batch on purpose: an "Add all" over N ingredients is ONE
 * call with N questions (the state's tokens are counted once, so
 * per-item questions are cheap), never N calls.
 *
 * State assembly and answer parsing are pure functions, tested at
 * tests/grocery-section-agent.test.ts.
 */
import type { GrocerySection, SupabaseService } from './supabase';
import { normalizeGroceryName } from './ui/grocery-list';
import { createLogger } from './logger.svelte';

const log = createLogger('grocery-section');

/**
 * The decision model: `clef-api`, Venice's private-tier decision
 * model (zero data retention, matching the agent fleet's posture).
 * Beta - the Decisions API's wire shape may change without notice,
 * which the verbatim relay and the defensive coercion absorb.
 */
const DECISION_MODEL = 'clef-api';

/**
 * Cap on example rows fetched for the state. Most-recently-updated
 * filed staples win server-side; buildSectionPromptGroups then caps
 * per section so one over-stuffed aisle cannot crowd out the rest.
 */
export const SECTION_EXAMPLE_FETCH_LIMIT = 80;

/** Max example item names shown per section in the state. */
export const SECTION_EXAMPLES_PER_SECTION = 6;

/**
 * Cap on the cooklang source included as recipe context. Recipes
 * are normally far smaller; the cap only guards a pathological
 * paste from bloating the state.
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
): Array<{ name: string; examples: string[] }> {
  const bySection = new Map<string, string[]>();
  for (const ex of examples) {
    const list = bySection.get(ex.section_id) ?? [];
    if (list.length < SECTION_EXAMPLES_PER_SECTION) list.push(ex.name);
    bySection.set(ex.section_id, list);
  }
  return sections.map((s) => ({
    name: s.name,
    examples: bySection.get(s.id) ?? [],
  }));
}

/**
 * The instruction each per-item question carries. Question ids are
 * not sent to the model - only the instructions and criteria are -
 * so the item name rides INSIDE the instruction text.
 */
function itemQuestion(name: string, criteria: Record<string, string | null>) {
  return {
    type: 'choice',
    instructions:
      `Which of the sections listed in criteria fits the item "${name}" ` +
      'best? Judge by how grocery stores are typically laid out, by the ' +
      'example items the shopper has already filed (in the state), and ' +
      'by the recipe context when one is present. Pick "none" when no ' +
      'section fits well.',
    criteria,
  };
}

/**
 * Assemble the decision request: JSON state (sections with examples,
 * optional recipe, items) plus one `choice` question per item whose
 * criteria are the section names. Criteria are keyed by section NAME
 * (not id) so the model echoes a readable string; the parser maps
 * the name back to the id. The `none` option preserves the chat
 * path's "0 = no good fit" escape hatch.
 */
export function buildDecisionBody(args: {
  sections: readonly GrocerySection[];
  examples: readonly GrocerySectionExample[];
  names: readonly string[];
  recipe?: GroceryRecipeContext;
}): Record<string, unknown> {
  const groups = buildSectionPromptGroups(args.sections, args.examples);
  const state: Record<string, unknown> = {
    sections: groups,
    items: [...args.names],
  };
  if (args.recipe) {
    state.recipe = {
      title: args.recipe.title,
      ingredients: args.recipe.cooklang.slice(0, RECIPE_CONTEXT_MAX_CHARS),
    };
  }
  // One shared criteria map - every question evaluates against the
  // same section list.
  const criteria: Record<string, string | null> = {};
  for (const g of groups) {
    criteria[g.name] =
      g.examples.length > 0 ? `Examples: ${g.examples.join(', ')}` : null;
  }
  criteria.none = 'No good fit; leave the item unfiled.';
  const questions: Record<string, unknown> = {};
  for (const name of args.names) {
    questions[name] = itemQuestion(name, criteria);
  }
  return { model: DECISION_MODEL, state, questions };
}

/** One parsed answer: the section to file into, and how sure the model was. */
export interface SectionPick {
  sectionId: string;
  confidence: number;
}

/**
 * Coerce Venice's `{ answers: { [itemId]: { choice, confidence } } }`
 * into name -> pick. Question ids are the item names exactly as
 * sent, and answers come back keyed by the same ids server-side, so
 * the lookup is by exact name (the old chat path's key-casing
 * tolerance is dead code here - the model cannot drift the keys).
 * Anything not mapping to a real section - a missing answer, an
 * unknown section name, the `none` pick - drops that item, leaving
 * it unfiled.
 */
export function parseDecisionAnswers(
  payload: unknown,
  names: readonly string[],
  sections: readonly GrocerySection[]
): Map<string, SectionPick> {
  const out = new Map<string, SectionPick>();
  if (payload === null || typeof payload !== 'object') return out;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return out;
  }
  const byId = answers as Record<string, unknown>;
  // First match wins on duplicate section names - a user-created
  // collision is rare and either target is plausible. Built by hand:
  // a Map constructed from the entries array would let the LAST
  // duplicate win.
  const byName = new Map<string, GrocerySection>();
  for (const s of sections) {
    if (!byName.has(s.name)) byName.set(s.name, s);
  }
  for (const name of names) {
    const answer = byId[name];
    if (!answer || typeof answer !== 'object') continue;
    const choice = (answer as { choice?: unknown }).choice;
    if (typeof choice !== 'string' || choice === 'none') continue;
    const section = byName.get(choice);
    if (!section) continue;
    const raw = (answer as { confidence?: unknown }).confidence;
    const confidence =
      typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    out.set(normalizeGroceryName(name), {
      sectionId: section.id,
      confidence,
    });
  }
  return out;
}

/**
 * Run one classification: fetch sections + examples, call the
 * decision model through the /decisions relay, and return a pick for
 * every item the model placed. Empty map on any failure (fail
 * closed - the products stay in Other).
 */
export async function classifyGrocerySections(
  supabase: SupabaseService,
  args: { names: readonly string[]; recipe?: GroceryRecipeContext }
): Promise<Map<string, SectionPick>> {
  if (args.names.length === 0) return new Map();
  try {
    const [sections, examples] = await Promise.all([
      supabase.listGrocerySections(),
      supabase.listSectionExampleProducts(SECTION_EXAMPLE_FETCH_LIMIT),
    ]);
    if (sections.length === 0) return new Map();
    const payload = await supabase.decide(
      buildDecisionBody({
        sections,
        examples,
        names: args.names,
        recipe: args.recipe,
      })
    );
    const picks = parseDecisionAnswers(payload, args.names, sections);
    for (const name of args.names) {
      const pick = picks.get(normalizeGroceryName(name));
      if (!pick) continue;
      const sectionName =
        sections.find((s) => s.id === pick.sectionId)?.name ?? pick.sectionId;
      log.info(
        `auto-filing "${name}" -> "${sectionName}" (confidence ${pick.confidence.toFixed(2)})`
      );
    }
    return picks;
  } catch (err) {
    log.warn('classification failed; leaving items unfiled', err);
    return new Map();
  }
}

/**
 * The fire-and-forget entry every add path uses: classify the given
 * products (in ONE call) and file each placed one that is still
 * unfiled. Returns true when at least one product was filed, so the
 * caller knows a refresh is worth it. Never throws.
 */
export async function autoFileProducts(
  supabase: SupabaseService,
  products: ReadonlyArray<{ id: string; name: string }>,
  recipe?: GroceryRecipeContext
): Promise<boolean> {
  const picks = await classifyGrocerySections(supabase, {
    names: products.map((p) => p.name),
    recipe,
  });
  if (picks.size === 0) return false;
  let filed = false;
  for (const p of products) {
    const pick = picks.get(normalizeGroceryName(p.name));
    if (!pick) continue;
    try {
      await supabase.autoFileGroceryProduct(p.id, pick.sectionId);
      filed = true;
    } catch (err) {
      // Per-product save failures leave that product in Other; the
      // rest of the batch still files.
      log.warn(`auto-file failed for ${p.name}`, err);
    }
  }
  return filed;
}
