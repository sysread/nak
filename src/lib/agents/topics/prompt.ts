/**
 * The topics agent's system prompt. The model gets the full
 * conversation as a prior transcript plus a final user turn that
 * carries this instruction and the existing-topics vocabulary.
 *
 * Output shape: a JSON object `{ "topics": ["..."] }` with 1-4 short
 * lowercase strings. The agent parses + validates this; anything that
 * doesn't fit (missing key, non-array value, items that aren't
 * strings) is dropped silently and the row re-enters the queue on the
 * next cycle.
 *
 * Design notes:
 *   - "Reuse names from the existing list if any fit" is the
 *     normalisation step. Without it the vocabulary sprawls into
 *     near-duplicates ("baking", "bakes", "baked-goods") and the
 *     drawer dropdown turns into noise within a month. The prompt
 *     spells out the goal in plain language because the fast model
 *     responds better to "here's why we want this" than to "obey rule
 *     N." Empty existing-list (brand-new account) is fine; the model
 *     picks freely on the first few threads and the vocabulary
 *     self-seeds.
 *   - "1-4 topics" is the cap. One is the floor because a thread
 *     never genuinely has zero topics (the conversation is about
 *     SOMETHING); the eligibility predicate ensures we never call
 *     the agent on a thread without an assistant turn. Four is the
 *     ceiling because more tags than that turns the filter into
 *     noise - every thread matches every filter.
 *   - "Lowercase, no punctuation except hyphens, no plurals" is the
 *     normalisation hint. "bread" and "breads" should collapse to
 *     "bread"; "Cooking" and "cooking" to "cooking". The agent post-
 *     processes too (toLowerCase, strip non-alphanum-or-hyphen) but
 *     the prompt makes the right shape the first attempt.
 *   - "Topical, not conversational" mirrors the summary prompt's
 *     framing - same rationale, same wording so the two agents agree
 *     on what counts as a "topic" vs a "shape of the exchange".
 *
 * The reserved sentinel "(untagged)" is forbidden explicitly so the
 * model can't accidentally emit a string that would mean "this row
 * has no topics" to the filter UI - it's a UI primitive, not a real
 * topic.
 */
export const TOPICS_PROMPT_PREFIX = `You've just finished the conversation above. Step out of that role.
Nobody will read this reply as a chat turn - the output is being
written to a database column that powers a topic-filter dropdown in
the conversation list.

Pick 1-4 short topic tags describing what this conversation is about.

Rules for each tag:
- Lowercase. ASCII letters, digits, and hyphens only.
- One or two words. Prefer single words ("baking") over phrases
  ("bread-baking") unless the single word would be too generic
  ("project" -> "saas-onboarding").
- Singular, not plural ("recipe" not "recipes").
- Topical, not conversational. "sourdough" beats "questions"; the
  subject matter is the topic, not the shape of the exchange.
- Do NOT use the literal string "(untagged)" - it's a UI primitive,
  not a topic.

If any of the tags below already fit, REUSE them verbatim instead of
minting a near-duplicate. The goal is a small, stable vocabulary - a
new tag should only appear when no existing tag fits.

Existing tags (reuse if any apply):
`;

/**
 * The closing portion of the prompt, after the existing-topics list
 * gets inlined. Split so the agent can build the full prompt with
 * either an empty list or a comma-separated rendering of the
 * vocabulary.
 */
export const TOPICS_PROMPT_SUFFIX = `

Output a single JSON object with one key, "topics", whose value is an
array of strings:

{"topics": ["baking", "sourdough"]}

No preamble, no trailing text, no markdown fence. Just the object.`;

/**
 * Render the full prompt for a given existing-topics vocabulary. An
 * empty list renders as "(none yet)" so the model sees a clear marker
 * instead of a dangling blank.
 */
export function buildTopicsPrompt(existingTopics: readonly string[]): string {
  const list =
    existingTopics.length === 0
      ? '(none yet)'
      : existingTopics.join(', ');
  return TOPICS_PROMPT_PREFIX + list + TOPICS_PROMPT_SUFFIX;
}
