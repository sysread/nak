/**
 * The memory-topics agent's system prompt. The model is shown one
 * memory's label and data, plus the existing per-account topic
 * vocabulary, and asked for 1-4 short topic tags.
 *
 * Output shape: `{"topics": ["..."]}` - same shape as the thread topics
 * agent so the parser in `./agent.ts` and the thread topics parser are
 * the same machinery.
 *
 * Why a different prompt from `../topics/prompt.ts`: the input shape is
 * different. The thread agent gets a conversation transcript and is
 * asked "what was this conversation ABOUT"; this agent gets a single
 * piece of free-form text (a fact the assistant remembered about the
 * user) and is asked "what SUBJECT does this fact concern". A memory
 * like "user is allergic to shellfish" should land under "allergies"
 * or "food" - the topic is the subject of the fact, not the fact
 * itself. Forcing the thread prompt onto memories produced verbose
 * tag sets that paraphrased the data field rather than categorising
 * it.
 *
 * The reserved "(untagged)" sentinel is forbidden explicitly for the
 * same reason the thread prompt forbids it - it's the filter UI's
 * "no topics on this row" marker, not a topic the agent should mint.
 */
export const MEMORY_TOPICS_PROMPT_PREFIX = `You are tagging one note the assistant has remembered about the user.
The note has a short LABEL and a longer DATA body. Your job is to pick
1-4 short topic tags describing the SUBJECT AREA the note concerns -
the category a user would file the note under, not a summary of what
the note says.

Examples to calibrate:
- LABEL "Allergic to shellfish", DATA "Reacts to shrimp and lobster.
  Carries an epi-pen." -> ["allergies", "food"]
- LABEL "Prefers vim", DATA "Uses neovim with lazyvim config; resists
  switching to vscode." -> ["editor", "tooling"]
- LABEL "Lives in Berlin", DATA "Moved from London in 2023; speaks
  intermediate German." -> ["location", "language"]
- LABEL "Daughter named Maya", DATA "Born 2019; allergic to peanuts."
  -> ["family", "allergies"]

Rules for each tag:
- Lowercase. ASCII letters, digits, and hyphens only.
- One word ("allergies") preferred; two-word hyphenated phrase ("dietary-restrictions")
  only when one word is too generic to be useful.
- Prefer the form that reads naturally as a category name.
  "allergies" / "preferences" read more naturally than "allergy" /
  "preference" for category tags; "vim" stays singular because it
  names a specific thing. When in doubt, match the form already used
  in the existing vocabulary below.
- Subject area, not the assertion itself. "shellfish-allergy" is a
  fact; "allergies" is its category.
- Do NOT use the literal string "(untagged)" - it's a UI primitive,
  not a topic.

If any of the tags below already fit, REUSE them verbatim instead of
minting a near-duplicate. The goal is a small, stable vocabulary - a
new tag should only appear when no existing tag fits.

Existing tags (reuse if any apply):
`;

/**
 * Closing portion of the prompt, after the existing-topics list is
 * inlined. Split so the agent builder can choose between rendering the
 * vocabulary as a comma-separated list or the empty-account marker.
 */
export const MEMORY_TOPICS_PROMPT_SUFFIX = `

Output a single JSON object with one key, "topics", whose value is an
array of strings:

{"topics": ["allergies", "food"]}

No preamble, no trailing text, no markdown fence. Just the object.`;

/**
 * Build the model-facing user-turn body. Renders the memory's label
 * and data verbatim (no escaping - the model is meant to read them as
 * prose) framed by the instruction prefix + closing suffix.
 *
 * Empty existing-topics list renders as "(none yet)" so the model sees
 * a clear marker instead of a dangling blank.
 */
export function buildMemoryTopicsPrompt(
  label: string,
  data: string,
  existingTopics: readonly string[]
): string {
  const vocab =
    existingTopics.length === 0 ? '(none yet)' : existingTopics.join(', ');
  return (
    MEMORY_TOPICS_PROMPT_PREFIX +
    vocab +
    '\n\nThe note:\n\nLABEL: ' +
    label +
    '\n\nDATA: ' +
    data +
    MEMORY_TOPICS_PROMPT_SUFFIX
  );
}
