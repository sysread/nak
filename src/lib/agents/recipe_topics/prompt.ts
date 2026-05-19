/**
 * The recipe-topics agent's system prompt. The model is shown one
 * recipe's title and cooklang source, plus the existing per-account
 * topic vocabulary, and asked for 1-6 short topic tags spanning
 * primary ingredients, cuisine, course, and technique.
 *
 * Output shape: `{"topics": ["..."]}` - same shape as the thread and
 * memory topics agents so the parser in `./agent.ts` is the same
 * machinery.
 *
 * Why a different prompt from `../memory_topics/prompt.ts`: the input
 * is structured Cooklang source, not free-form prose, and the topic
 * dimensions are fixed and concrete (ingredient / cuisine / course /
 * technique) rather than open-ended subject areas. Pushing recipes
 * through the memory prompt produced ingredient-name dumps - every
 * single `@ingredient{}` reference became a tag - which buried the
 * primary protein under salt, pepper, and garlic. The fix is the
 * "PRIMARY ingredients only" rule below plus worked examples
 * showing the bias.
 *
 * The four dimensions:
 *
 *   - PRIMARY INGREDIENT(S). Headline protein and/or vegetable.
 *     "chicken", "salmon", "tofu", "broccoli". NOT pantry stuff
 *     (salt, oil, sugar, flour, common spices) - those are
 *     ubiquitous and don't differentiate one recipe from another.
 *     Cap intent: pick the 1-2 ingredients a hungry user would
 *     describe the dish by ("the chicken thing", "the eggplant
 *     thing").
 *
 *   - CUISINE. The dish's cultural family when obvious. "italian",
 *     "thai", "mexican", "indian". Skip when the recipe is
 *     deliberately cross-cultural or generic.
 *
 *   - COURSE. "breakfast", "dinner", "dessert", "side", "snack",
 *     "appetizer". The slot the dish fits into in a meal.
 *
 *   - TECHNIQUE. The dominant cooking method when it's a defining
 *     feature. "grilled", "baked", "no-cook", "slow-cook",
 *     "one-pot", "stir-fry". Skip when the method is incidental
 *     ("boiled pasta" is just "pasta").
 *
 * Cap is 1-6 because recipes legitimately span those four
 * dimensions. Forcing 1-4 (the thread cap) made the model drop
 * cuisine or course on multi-dimensional dishes ("chicken tikka
 * masala" wants chicken + indian + dinner + curry); 6 lets all
 * four land plus two ingredient names where the dish has multiple
 * headline ingredients.
 */
export const RECIPE_TOPICS_PROMPT_PREFIX = `You are tagging one recipe from the user's cookbook. The recipe has
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

2. CUISINE. The dish's cultural family when obvious. "italian",
   "thai", "indian", "mexican". Skip when the recipe is cross-
   cultural or generically western.

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

/**
 * Closing portion of the prompt, after the existing-topics list is
 * inlined. Split so the agent builder can render the vocabulary as
 * a comma-separated list or the empty-account marker.
 */
export const RECIPE_TOPICS_PROMPT_SUFFIX = `

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
export function buildRecipeTopicsPrompt(
  title: string,
  cooklang: string,
  existingTopics: readonly string[]
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
