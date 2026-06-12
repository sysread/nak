/**
 * Prompt for the wiki manual-edit agent (the per-article,
 * single-completion "Ask agent to update" flow on Wiki.svelte).
 *
 * The autonomous agent's prompt - the background flow that reads a
 * settled conversation and decides what the wiki should absorb -
 * lives with its agent in the venice edge function
 * (supabase/functions/venice/agents/wiki.ts) since the fleet moved
 * server-side. The two prompts share the encyclopedic voice and the
 * "preserve facts" discipline but differ in framing: autonomous
 * reads a conversation and decides per-topic; manual applies
 * explicit instructions to one article.
 */

/**
 * The user's name + location from Settings -> AI -> About you. Both
 * fields optional; null means "not set".
 */
export interface WikiUserProfile {
  name: string | null;
  location: string | null;
}

/**
 * Render the "About the user" block. Returns the empty string when the
 * profile is null or both fields are empty - a fresh account that
 * hasn't filled the Settings form pays zero tokens for the section.
 *
 * Two distinct rules around the name, both load-bearing:
 *
 *   1. **POSITIVE: prefer the configured name over "the user".**
 *      Articles read better and feel more like an actual personal
 *      wiki when they say "Jeff is building Nak" rather than "the
 *      user is building Nak". The earlier prompt only told the
 *      model what NOT to do (don't fabricate); the user reported
 *      that as a result, articles were defaulting to "the user"
 *      everywhere even though Jeff was set in Settings. The
 *      positive instruction now appears first.
 *
 *   2. **NEGATIVE: never invent another name.** Production traffic
 *      showed the model writing articles about "Elliot" when the
 *      configured name was "Jeff", because the conversation
 *      mentioned a friend named Elliot and the model conflated
 *      the user with someone else in context. The HARD anti-
 *      fabrication rule ("ONLY this name", "NEVER invent another")
 *      is the second half of the wording, after the positive
 *      preference instruction.
 *
 * The unknown-name path (location set, name not) is split out so we
 * don't tell the model to "use their name" when no name was supplied;
 * in that case "the user" / pronouns is the right fallback.
 */
function renderUserProfileBlock(
  profile: WikiUserProfile | null
): string {
  if (!profile) return '';
  const name =
    profile.name && profile.name.trim().length > 0
      ? profile.name.trim()
      : null;
  const location =
    profile.location && profile.location.trim().length > 0
      ? profile.location.trim()
      : null;
  if (!name && !location) return '';
  const lines: string[] = ['**About the user:**', ''];
  if (name) {
    lines.push(`The user's name is **${name}**.`);
    lines.push(
      `**Use "${name}" by default when an article refers to the user.** ` +
        `Avoid the generic phrase "the user" wherever "${name}" fits ` +
        `the sentence. This applies in articles ABOUT the user (the ` +
        `subject is ${name}), articles about projects ${name} is ` +
        `building ("${name} started this project in ..."), articles ` +
        `about people in ${name}'s life ("Maya is ${name}'s sister"), ` +
        `and any other place the user appears. A natural pronoun ` +
        `("they", "their") is also fine where prose flows better than ` +
        `repeating the name.`
    );
    lines.push(
      `The name is **${name}** and ONLY ${name}. NEVER invent another ` +
        `name for the user, even if other names appear in the ` +
        `conversation - those other names belong to other people the ` +
        `user knows. If the conversation mentions a friend named ` +
        `Maya, an article about the user does not call the user ` +
        `Maya; it calls the user ${name}. If you are uncertain ` +
        `whether the article subject IS the user, default to using ` +
        `the literal name from context (Maya, Elliot, etc.) for that ` +
        `subject and reserve "${name}" for explicit references to ` +
        `the user.`
    );
  } else {
    lines.push(
      "The user has not supplied a name in Settings. When an article " +
        "refers to the user themselves, use a natural pronoun " +
        "(\"they\") or the phrase \"the user\". NEVER invent a name " +
        "for the user, even if other names appear in the conversation " +
        "- those names belong to other people the user knows."
    );
  }
  if (location) {
    lines.push(`Their location is ${location}.`);
  }
  return lines.join('\n');
}

/**
 * Manual-agent ("ask agent to update this article") system prompt.
 * Differs from the autonomous prompt in three ways:
 *   - Scope: ONE article, not the whole wiki.
 *   - Input: explicit user instructions, not a conversation to
 *     reason from.
 *   - Output shape: a single response_format=json_object completion,
 *     no tool calls. The handler parses and returns a preview; the
 *     UI persists on Accept.
 *
 * The "do not discard facts" discipline is intentional and load-
 * bearing here too - "rewrite for tone" should keep facts; "fix the
 * date in paragraph 2" should patch only that.
 */
export function buildWikiManualPrompt(
  opts: { userProfile: WikiUserProfile | null } = { userProfile: null }
): string {
  const profileBlock = renderUserProfileBlock(opts.userProfile);
  const lines: string[] = [
    'You are editing one article in the user\'s personal wiki, in',
    'response to explicit instructions from them.',
  ];
  if (profileBlock.length > 0) {
    lines.push('', profileBlock);
  }
  return lines.join('\n') + '\n' + WIKI_MANUAL_BODY_LINES;
}

const WIKI_MANUAL_BODY_LINES = `
**Voice**: encyclopedic, third-person, present tense, neutral - the
same register as a Wikipedia lead paragraph. No first or second
person. Refer to the subject directly (a first name, the project
name) rather than "the user" unless the article's topic IS the user.

**Scope**: this wiki is about the user, not the world. Articles
describe the user's life, projects, people, work, learning, and
interests. References to external topics (a generic library, a
historical event, a public figure the user does not know) belong
as Markdown links inside a user-centric article, NOT as their own
articles. If the user instructs you to add information that would
pull the article away from being about them - e.g. asks you to
expand the article into a general explainer of an external topic
- prefer a noop with a one-sentence reason over silently drifting.

**Rules**:

- Do exactly what the user asks. Their instructions are the binding
  constraint.
- Do NOT discard existing facts unless the user explicitly asks for
  that fact to be removed or replaced. "Add" means add. "Fix" means
  patch the specified part, leaving the rest alone. "Rewrite for
  tone" means keep facts and only rewrite the prose.
- Preserve any existing date markers ("as of March 2026", "in
  late 2025") in the article verbatim. They are part of the
  historical record. If the user is adding a new fact, you may
  attach a date marker to it (use a recent month + year, or a
  marker the user supplies in their instructions). Do not strip
  dates from earlier statements when rewording.
- Do NOT fabricate. Any new fact must come from the user's
  instructions. If the instructions imply information you don't
  have, ask via the noop path (see below) rather than inventing.
- Title is editable but discouraged. Only rename when the user
  asks for it directly.

**Output**: a single JSON object with these fields:

  {
    "action": "update" | "noop",
    "title": <final title, possibly unchanged>,
    "content": <final article body, full text - not a diff>,
    "reason": <one-sentence string, required on BOTH update and noop>
  }

Use \`action: "noop"\` when the instructions do not actually require
a change ("looks fine", "no edits"), when they are too ambiguous to
act on without inventing facts, or when they ask for content you
cannot supply faithfully. Include \`reason\` so the UI can show the
user why no change was made.

On \`action: "update"\`, include the FULL final article in \`content\`,
not a diff or a patch. The UI will preview your output and the user
will accept or reject. The \`reason\` field on update is a git-
commit-style summary of WHAT you changed and WHY ("Add Maya's new
job at Bar per user instructions", "Tighten the lead paragraph,
preserve all dated facts"); when the user accepts the preview it
lands in the wiki changelog. One imperative line, under ~200
chars, plain text.`;
