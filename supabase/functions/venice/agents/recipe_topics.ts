// Recipe topic-tagging work unit (function-side port of
// src/lib/agents/recipe_topics/). One tagging pass per cycle: the
// claim RPC returns the recipe's title + cooklang + the user's
// existing topic vocabulary in a single round trip, so the run half
// just builds the prompt, calls the fast model with a JSON-pinned
// response format, and parses + validates the output before the save
// RPC. The tags power the cookbook's topic filter.
//
// Shape mirrors ./memory_topics.ts deliberately - same claim ->
// complete -> parse -> save-or-clear progression, same save guard
// driven by `last_topics_at` with a title/cooklang change trigger
// re-queueing edited rows. The differences are the input shape
// (title + cooklang instead of label + data), the prompt, and the
// cap (6 instead of 4 - recipes span more dimensions, see the prompt
// comment for the reasoning).
//
// Two drivers share the run half: tagOneRecipe (per-user claim from a
// chat turn's waitUntil tail, via ./curation.ts) and
// sweepClaimAndTagRecipe (cross-user claim from the hourly curation
// sweep). Both are best-effort and non-throwing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import {
  completeJsonObject,
  CURATION_CLAIM_TTL_SECONDS,
} from './_curation_helpers.ts';

// Mirror of agentModel('recipeTopics').id in src/lib/models/index.ts.
// AGENT_MODELS is a static role->model map, NOT one of the per-user
// configurable tiers, so the browser path resolved this same constant -
// hardcoding it here stays faithful after the cutover.
const RECIPE_TOPICS_MODEL = 'mistral-small-3-2-24b-instruct';

// Mirror of UNTAGGED_TOPIC_SENTINEL in src/lib/supabase.ts - the
// filter UI's "no topics on this row" marker, forbidden as a tag.
const UNTAGGED_TOPIC_SENTINEL = '(untagged)';

/**
 * Tag cap. Higher than threads (4) and memories (4) because recipes
 * legitimately span four dimensions (primary ingredients + cuisine +
 * course + technique). Forcing 1-4 made the model drop cuisine or
 * course on multi-dimensional dishes ("chicken tikka masala" wants
 * chicken + indian + dinner + curry); 6 lets all four land plus a
 * second headline ingredient on multi-protein dishes.
 */
const MAX_RECIPE_TOPICS = 6;

/**
 * The recipe-topics instruction. Verbatim copy of
 * RECIPE_TOPICS_PROMPT_PREFIX / RECIPE_TOPICS_PROMPT_SUFFIX in
 * src/lib/agents/recipe_topics/prompt.ts so the model gets identical
 * guidance whichever path drove it.
 *
 * Why a different prompt from the memory topics unit: the input is
 * structured Cooklang source, not free-form prose, and the topic
 * dimensions are fixed and concrete (ingredient / cuisine / course /
 * technique) rather than open-ended subject areas. Pushing recipes
 * through the memory prompt produced ingredient-name dumps - every
 * single `@ingredient{}` reference became a tag - which buried the
 * primary protein under salt, pepper, and garlic. The "PRIMARY
 * ingredients only" rule plus the worked examples below carry the
 * bias.
 */
const RECIPE_TOPICS_PROMPT_PREFIX = `You are tagging one recipe from the user's cookbook. The recipe has
a TITLE and a COOKLANG body (Cooklang is a recipe markup language;
treat it as the source of truth for ingredients and steps). Your job
is to pick 1-6 short topic tags so the user can filter their cookbook
by what kind of dish this is.

Pick tags across these four dimensions (skip any that don't apply):

1. PRIMARY INGREDIENT(S). The 1-2 headline proteins or vegetables
   the dish is built around. NOT pantry staples - salt, oil, sugar,
   flour, butter, garlic, onion, common spices are too ubiquitous to
   tag. Pick the ingredients a hungry user would describe the dish
   by ("the chicken thing", "the eggplant thing").

2. CUISINE. The dish's cultural family - tag this generously. Most
   recipes lean on at least one ("italian", "thai", "indian",
   "mexican"), so reach for a cuisine tag whenever a dish has any
   cultural identity. A fusion or cross-cultural dish should get a
   tag for EACH cuisine it draws on - a Korean-Mexican taco is both
   "korean" and "mexican", not neither. Skip cuisine only when the
   dish is genuinely generic with no cultural lean.

3. COURSE. "breakfast", "dinner", "dessert", "side", "snack",
   "appetizer". The slot the dish fills in a meal.

4. TECHNIQUE. The dominant cooking method when it's a defining
   feature. "grilled", "baked", "no-cook", "slow-cook", "one-pot",
   "stir-fry". Skip when the method is incidental.

Examples to calibrate:
- TITLE "Chicken Tikka Masala", curry ingredients in cooklang
  -> ["chicken", "indian", "curry", "dinner"]
- TITLE "Banana Bread", flour/banana/sugar in cooklang
  -> ["banana", "baked", "dessert"]
- TITLE "Caesar Salad", romaine/anchovy/parmesan in cooklang
  -> ["romaine", "salad", "side", "no-cook"]
- TITLE "Pad Thai", rice noodle/shrimp/peanut/tamarind in cooklang
  -> ["shrimp", "noodles", "thai", "dinner", "stir-fry"]
- TITLE "Korean BBQ Tacos", bulgogi/tortilla/kimchi in cooklang
  -> ["beef", "korean", "mexican", "dinner"]
- TITLE "Overnight Oats", oats/milk/honey in cooklang
  -> ["oats", "breakfast", "no-cook"]
- TITLE "Roasted Brussels Sprouts", sprouts/olive oil/lemon
  -> ["brussels-sprouts", "side", "roasted"]

Rules for each tag:
- Lowercase. ASCII letters, digits, and hyphens only.
- One word ("chicken", "italian") preferred; two-word hyphenated
  phrase ("stir-fry", "brussels-sprouts") only when one word is
  ambiguous or unnatural.
- Singular when the tag names a single thing ("chicken", not
  "chickens"); plural when the dish is the category ("noodles",
  "oats"). Match what's already in the existing vocabulary below.
- Skip pantry staples (salt, oil, butter, flour, sugar, garlic,
  onion, common spices) - they don't differentiate one recipe
  from another.
- Do NOT use the literal string "(untagged)" - it's a UI primitive,
  not a topic.

If any of the tags below already fit, REUSE them verbatim instead of
minting a near-duplicate. The goal is a small, stable vocabulary - a
new tag should only appear when no existing tag fits.

Existing tags (reuse if any apply):
`;

const RECIPE_TOPICS_PROMPT_SUFFIX = `

Output a single JSON object with one key, "topics", whose value is an
array of strings (1-6 items):

{"topics": ["chicken", "indian", "curry", "dinner"]}

No preamble, no trailing text, no markdown fence. Just the object.`;

/**
 * Build the model-facing user-turn body. Renders the recipe's title
 * and cooklang verbatim (no escaping - the model is expected to read
 * them) framed by the instruction prefix + closing suffix.
 *
 * Empty existing-topics list renders as "(none yet)" so the model
 * sees a clear marker instead of a dangling blank.
 */
function buildRecipeTopicsPrompt(
  title: string,
  cooklang: string,
  existingTopics: readonly string[],
): string {
  const vocab =
    existingTopics.length === 0 ? '(none yet)' : existingTopics.join(', ');
  return (
    RECIPE_TOPICS_PROMPT_PREFIX +
    vocab +
    '\n\nThe recipe:\n\nTITLE: ' +
    title +
    '\n\nCOOKLANG:\n' +
    cooklang +
    RECIPE_TOPICS_PROMPT_SUFFIX
  );
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the prompt's "no markdown fence" instruction. Duplicated
 * across the three topics units rather than extracted - keeping each
 * unit's validator next to its prompt beats a shared util that has
 * to grow for every caller's edge cases (see CLAUDE.md on premature
 * abstraction).
 */
function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
    return withoutFence.trim();
  }
  return trimmed;
}

/**
 * Per-tag validation + normalisation. Identical rules to the sibling
 * topics units: lowercase, strip non-alphanum-or-hyphen, length
 * 1..40, can't equal the "(untagged)" sentinel.
 */
function normaliseTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.toLowerCase().trim();
  if (lowered.length === 0) return null;
  const cleaned = lowered.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length === 0 || cleaned.length > 40) return null;
  if (cleaned === UNTAGGED_TOPIC_SENTINEL) return null;
  return cleaned;
}

/**
 * Parse the model's raw output into a validated topic list. Caps at
 * MAX_RECIPE_TOPICS items. Returns [] on any parse failure or all-
 * invalid items - the driver's "empty-topics" branch then releases
 * the claim without writing.
 */
function parseTopics(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const list = obj.topics;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const norm = normaliseTag(item);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= MAX_RECIPE_TOPICS) break;
  }
  return out;
}

/** Outcome of one recipe-topics cycle, mirroring the browser unit's CycleResult vocabulary. */
export type RecipeTopicsOutcome =
  /** No claimable recipe - everything is tagged, claimed, or ineligible. */
  | 'empty-queue'
  /** Claimed, tagged, saved. The queue may hold more rows. */
  | 'tagged'
  /**
   * The save RPC returned false - another run took over mid-tagging,
   * or the user edited the recipe between claim and save and the
   * trigger nulled our claim. Not an error; drop the work and drain.
   */
  | 'claim-lost'
  /**
   * Agent produced no usable topics. Claim is released so the row
   * re-enters the queue immediately; the next cycle retries.
   */
  | 'empty-topics'
  /** Supabase or Venice errored during the cycle. */
  | 'error';

/**
 * The run half shared by both drivers: the caller already holds the
 * per-recipe claim; this tags the recipe and saves-or-clears.
 * Non-throwing - every failure path folds into an outcome the drain
 * loops in ./curation.ts can act on.
 */
async function tagClaimedRecipe(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  holderId: string,
  recipeId: string,
  title: string,
  cooklang: string,
  existingTopics: readonly string[],
): Promise<RecipeTopicsOutcome> {
  log.info(`picked up recipe ${recipeId} (vocab=${existingTopics.length})`);

  let topics: string[];
  try {
    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    // 384 tokens covers the worst case: six 40-char tags. The bound
    // matters because the model is told to emit JSON only; a runaway
    // prose preamble would otherwise eat the budget before the actual
    // array lands. The cap is generous - typical output is well under
    // 100 tokens.
    const text = await completeJsonObject({
      apiKey,
      model: RECIPE_TOPICS_MODEL,
      messages: [
        {
          role: 'user',
          content: buildRecipeTopicsPrompt(title, cooklang, existingTopics),
        },
      ],
      maxTokens: 384,
    });
    topics = parseTopics(text);
  } catch (err) {
    log.debug(
      `recipe ${recipeId} agent reported error`,
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }

  if (topics.length === 0) {
    // Model produced nothing usable. Release the claim so the row
    // re-enters the queue immediately. Best-effort: if the clear RPC
    // fails, the per-recipe claim TTL will let the row re-enter the
    // queue eventually anyway.
    try {
      await adminClient.rpc('clear_recipe_topics_claim', {
        p_recipe_id: recipeId,
        p_holder_id: holderId,
        p_user_id: userId,
      });
    } catch {
      // see above
    }
    return 'empty-topics';
  }

  try {
    const { data: saved, error } = await adminClient.rpc(
      'save_recipe_topics_if_claimed',
      {
        p_recipe_id: recipeId,
        p_holder_id: holderId,
        p_topics: topics,
        p_user_id: userId,
      },
    );
    if (error) throw new Error(error.message);
    if (saved === true) {
      log.info(`tagged recipe ${recipeId}: [${topics.join(', ')}]`);
      return 'tagged';
    }
    log.debug(
      `claim lost on recipe ${recipeId} - ` +
        'another run took over mid-tagging, or the recipe was edited',
    );
    return 'claim-lost';
  } catch (err) {
    log.debug(
      `save RPC threw for recipe ${recipeId}`,
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
}

/** Coerce the claim row's existing_topics column to a clean string list. */
function asTopicList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * Run one recipe-topics cycle for `userId`: claim the oldest
 * tag-eligible recipe via the per-user RPC and tag it. Fired from the
 * chat-turn curation tail (./curation.ts), which owns the logger and
 * its flush. Non-throwing.
 */
export async function tagOneRecipe(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<RecipeTopicsOutcome> {
  // Fresh holder per call - the claim RPC's atomic per-recipe
  // claim+TTL is the mutual exclusion. Same no-lease posture as
  // ./reflection.ts.
  const holderId = crypto.randomUUID();
  let claim: {
    recipe_id?: unknown;
    title?: unknown;
    cooklang?: unknown;
    existing_topics?: unknown;
  } | null;
  try {
    // p_user_id is the b-strict escape hatch: the service-role admin
    // client has no auth.uid(), so the RPC scopes to the recipe owner
    // via coalesce(p_user_id, auth.uid()).
    const { data, error } = await adminClient.rpc('claim_next_recipe_for_topics', {
      p_holder_id: holderId,
      p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS,
      p_user_id: userId,
    });
    if (error) throw new Error(`claim_next_recipe_for_topics failed: ${error.message}`);
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log.error(
      'recipe-topics claim failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return 'error';
  }
  if (!claim || typeof claim.recipe_id !== 'string') return 'empty-queue';
  return await tagClaimedRecipe(
    adminClient,
    userId,
    log,
    holderId,
    claim.recipe_id,
    typeof claim.title === 'string' ? claim.title : '',
    typeof claim.cooklang === 'string' ? claim.cooklang : '',
    asTopicList(claim.existing_topics),
  );
}

/**
 * One sweep step: claim the most-overdue tag-eligible recipe across
 * ALL users (SECURITY DEFINER claim) and tag it. Driven by
 * runCurationSweepTick in ./curation.ts. The logger exists only once
 * a claim lands - a claim is what tells us WHOSE drawer the lines
 * belong in - and is flushed here because each claim may belong to a
 * different user. Non-throwing.
 */
export async function sweepClaimAndTagRecipe(
  adminClient: SupabaseClient,
): Promise<RecipeTopicsOutcome> {
  const holderId = crypto.randomUUID();
  let claim: {
    recipe_id?: unknown;
    title?: unknown;
    cooklang?: unknown;
    existing_topics?: unknown;
    user_id?: unknown;
  } | null;
  try {
    const { data, error } = await adminClient.rpc(
      'claim_next_recipe_for_topics_sweep',
      { p_holder_id: holderId, p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS },
    );
    if (error) {
      throw new Error(`claim_next_recipe_for_topics_sweep failed: ${error.message}`);
    }
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[recipe-topics-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
  if (!claim || typeof claim.recipe_id !== 'string' || typeof claim.user_id !== 'string') {
    return 'empty-queue';
  }

  const log = createEdgeLogger(claim.user_id, 'recipe-topics');
  try {
    return await tagClaimedRecipe(
      adminClient,
      claim.user_id,
      log,
      holderId,
      claim.recipe_id,
      typeof claim.title === 'string' ? claim.title : '',
      typeof claim.cooklang === 'string' ? claim.cooklang : '',
      asTopicList(claim.existing_topics),
    );
  } finally {
    // Flush before the sweep moves on so the outcome line isn't
    // dropped as an un-awaited broadcast when the tick settles.
    await log.flush();
  }
}

// Test-only surface: the parser + validator + cap are behavior parity
// with the browser agent (src/lib/agents/recipe_topics/) and get
// asserted in supabase/functions/tests/curation.test.ts.
export const __test = { parseTopics, normaliseTag, MAX_RECIPE_TOPICS };
