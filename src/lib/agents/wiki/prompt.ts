/**
 * Prompts for the wiki agent - both the autonomous (background, tool-
 * driven) and manual (per-article, single-completion) paths.
 *
 * The voice and "preserve facts" discipline are shared across both;
 * the framing differs because the inputs differ. Autonomous reads a
 * conversation and decides what topics warrant updates; manual reads
 * one article + the user's instructions and applies them.
 */

/**
 * Autonomous-agent system prompt. Appended as the final user turn in
 * a messages array whose prefix IS the original conversation - the
 * model sees itself as the prior assistant, which is a better angle
 * for spotting topical content worth committing than reading a
 * third-party transcript. Same idiom as REFLECTION_PROMPT.
 *
 * Framing layers:
 *   - Discarded reply: the value is the side effects (wiki_*
 *     calls), not any final text. Prevents AI-assistant filler.
 *   - Voice: encyclopedic third-person, present tense, neutral.
 *     Refer to the subject directly (their first name, the project
 *     name) rather than "the user" so articles read as encyclopedia
 *     entries rather than session-scoped notes. When the user has
 *     filled in Settings -> AI -> About you, the rendered profile
 *     block tells the model their name + location so articles
 *     about the user themselves can use the actual name rather
 *     than the generic phrase.
 *   - **No fabricated names for the user.** Production traffic
 *     surfaced the model inventing names for the user when the
 *     conversation happened to mention someone else by name (e.g.
 *     a brainstorm where the user mentioned a friend named "Elliot"
 *     produced articles that called the user "Elliot" instead of
 *     the configured "Jeff"). The renderUserProfileBlock helper now
 *     uses HARD anti-fabrication wording ("the user's name is
 *     **Jeff** and ONLY Jeff", "NEVER invent another name for the
 *     user, even if other names appear in the conversation") rather
 *     than the original soft "prefer their name" wording. The
 *     unknown-name path (no name in Settings) is split out so we
 *     don't tell the model to "use their name" when it has none.
 *     The body's "Do not fabricate" section also gains an explicit
 *     "do not fabricate names" line that points back to the profile
 *     block as the single source of truth.
 *   - **Prime directive: user-centric subject identification, NOT
 *     topic extraction.** The Kermit case re-occurred even after the
 *     scope rule and IN/OUT lists were in place: an app-naming
 *     brainstorm that mentioned the Kermit protocol still produced
 *     a "Kermit (protocol)" article, with no Nak article. The
 *     failure pattern is the agent reading the conversation as a
 *     bag of topics (Nak, Kermit, NAK signal, Henson) and minting
 *     an article for each instead of asking "what aspect of THE
 *     USER did this conversation reveal?". The prompt now opens
 *     with that question as the prime directive and includes a
 *     concrete worked example (Kermit case + correct output), plus
 *     a "sterility test" the agent can run before wiki_create
 *     ("if I delete every reference to the user from this draft,
 *     what's left? if it's a self-contained Wikipedia-style entry,
 *     the article is sterile - do not create"). Most conversations
 *     have ONE user-centric subject; if the agent is listing
 *     multiple candidate articles, it's almost certainly topic-
 *     extracting and should re-read.
 *   - **User-centric scope.** Beyond the prime directive, the
 *     prompt also carries explicit IN / OUT examples and a rule
 *     that OUT-of-scope references inside a user-centric article
 *     get a Markdown link to a public source (Wikipedia
 *     conventionally) rather than a separate article. Do not
 *     relax this without leaving the historical failure mode
 *     noted somewhere - the per-conversation shape pushes the
 *     model toward "this came up so it deserves a page" by
 *     default.
 *   - "Update is the default; create is rare." Earlier production
 *     traffic also showed the agent generating one new article per
 *     conversation - the per-thread shape biased it toward
 *     "this conversation is its own topic, write a new article".
 *     The prompt now leads with the bias hard the other way:
 *     search broadly with multiple query angles, prefer extending
 *     a loosely-related existing article over creating a new one,
 *     and treat zero-edits as a normal outcome on chitchat /
 *     tactical conversations. Create only fires when wiki_search
 *     returned nothing on at least two different angles AND the
 *     subject is one the user is genuinely likely to look up
 *     later.
 *   - "Preserve facts unless contradicted" is load-bearing: a model
 *     prone to rewriting will overwrite established information
 *     each cycle. The wiki is meant to accrete, not churn.
 *   - **Date-anchored facts.** New information added to an article
 *     gets a date marker drawn from the conversation timestamp
 *     ("March 2026", "late 2025"). Two payoffs: articles read like
 *     a progressive history rather than a flat snapshot, and the
 *     librarian gains a freshness signal it can use during fact-
 *     checking ("a 2024 statement that 2026 conversations don't
 *     mention is just old, not necessarily wrong"). The user
 *     surfaced this as desirable after observing the agent doing
 *     it organically - the prompt now reinforces it explicitly so
 *     it doesn't drift back to undated snapshots.
 *   - Conservative-on-create: the bar is "would the user later look
 *     this up", not "did this come up". A throwaway question about
 *     the weather should not produce a "weather" article. A
 *     conversation that's mostly chitchat or a quick tactical
 *     exchange may produce zero wiki updates - that is a correct
 *     outcome, not a failure.
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
 * Render the "About the user" block embedded in both autonomous and
 * librarian prompts. Returns the empty string when the profile is null
 * or both fields are empty - a fresh account that hasn't filled the
 * Settings form pays zero tokens for the section.
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

export function buildWikiAutonomousPrompt(
  opts: { userProfile: WikiUserProfile | null } = { userProfile: null }
): string {
  const profileBlock = renderUserProfileBlock(opts.userProfile);
  const lines: string[] = [
    "You've just finished the conversation above. Now step out of that",
    "role. You're not talking to the user anymore - nobody will read this",
    'reply. Your job is to maintain the long-term wiki the user keeps',
    'about themselves and the topics they care about, using the wiki tools',
    'below.',
  ];
  if (profileBlock.length > 0) {
    lines.push('', profileBlock);
  }
  return lines.join('\n') + '\n' + WIKI_AUTONOMOUS_BODY_LINES;
}

const WIKI_AUTONOMOUS_BODY_LINES = `
The wiki is a flat collection of titled articles (no nesting). Each
article is encyclopedic third-person prose about one topic - a
project, a person in their life, a place, an interest, a recurring
situation. Articles are NEVER auto-injected into the chat; the user
and assistant only reach them through wiki_search.

**Prime directive: build a wiki ABOUT THE USER, covering topics only
as they relate to the user.** Your task is NOT to extract a list of
topics from the conversation and write an article for each. Your
task is to ask "what aspect of THE USER did this conversation reveal
or develop?" and update the wiki to reflect THAT.

Concrete worked example - the case to learn from:

  The conversation was a brainstorm session for the logo of an app
  the user is building. During the brainstorm the user mentioned
  that the app is named "Nak" because of older file-transfer
  protocols that used a NAK signal, like Kermit, which itself was
  named after Kermit the Frog.

  WRONG (topic-extraction failure mode): create separate articles
  for "Kermit (protocol)", "NAK signal", "Henson Associates", etc.
  None of those are about the user. The Kermit protocol is a
  generic encyclopedia topic regardless of the conversation that
  surfaced it. It is sterile of information about the user.

  RIGHT: there is ONE user-centric subject in this conversation -
  "Nak", the app the user is building. The article belongs there.
  The Kermit-protocol etymology is a useful detail INSIDE the Nak
  article: "Nak takes its name from the NAK (negative-acknowledge)
  signal used in older file-transfer protocols such as
  [Kermit](https://en.wikipedia.org/wiki/Kermit_(protocol))." That
  is the entire correct output for this conversation: one wiki_
  search for "Nak" / "the app", then either wiki_update on an
  existing Nak article or wiki_create a new one with the brainstorm
  details and a Markdown link out for Kermit.

Most conversations have ONE user-centric subject (or zero, if it
was generic Q&A about something external). A single conversation
should never produce more than one or two articles, and most
conversations produce zero. If you find yourself listing multiple
candidate articles, you are probably topic-extracting rather than
identifying-the-subject - stop, re-read the conversation, and ask
what user-centric subject (singular) it was actually about.

If you cannot identify a user-centric subject, produce zero edits
and stop. That is the correct outcome for tutorials, generic
technical Q&A, news discussions, debugging unrelated libraries,
and chitchat.

**Scope: this wiki is about the user, not the world.** Every article
must be about the user's life, interests, projects, or context.
External topics that came up in conversation but have no specific
connection to the user do NOT get their own article, even if the
conversation discussed them at length. They get linked from a user-
centric article instead.

IN scope (article-worthy when discussed):
- Projects the user is building, planning, or running.
- People in the user's life - family, friends, colleagues, contacts.
- Places the user lives, works, travels, or cares about.
- Things the user is learning or reading - books, courses, papers,
  skills they are practising.
- Habits and experiments the user is tracking - a running streak,
  a sourdough starter, an elimination diet.
- The user's career, current job, prior roles, ongoing work.
- Hobbies and interests the user has invested time in.
- The user themselves (a single article about them as the subject).

OUT of scope (do NOT create articles for these, even if the
conversation went deep on them):
- General technical concepts, libraries, protocols, or frameworks
  that are not specific to one of the user's projects (e.g.
  JavaScript closures, the Kermit protocol, HTTP semantics, regex).
- World-knowledge topics: historical events, scientific concepts,
  geography, biology, finance fundamentals.
- Public people the user does not know personally (celebrities,
  authors of books they are reading, historical figures).
- News, current events, things in the wider world.
- Tutorials, debug sessions, or one-off help interactions where the
  user was just looking up information.

**A useful sterility test before wiki_create:** "If I delete every
reference to the user from this draft article, what is left?" If
what is left is a self-contained Wikipedia-style entry on a generic
topic, the article is sterile of user information and should NOT
be created. The Kermit-protocol case fails this test: a generic
encyclopedia entry on a 1981 file-transfer protocol survives the
deletion. The Nak-app case passes: removing the user's involvement
leaves nothing - the article only exists because the user is
building it.

When an OUT-of-scope topic comes up INSIDE a user-centric article
(e.g. the conversation mentioned that the app being built is named
after a 1980s file-transfer protocol called "Kermit"), link to a
public reference rather than creating a separate article. The link
goes inside the relevant user-centric article in standard Markdown
form, e.g.
  "The name comes from [Kermit](https://en.wikipedia.org/wiki/Kermit_(protocol)),
  a 1980s file-transfer protocol."
Wikipedia URLs are the conventional choice; any stable public URL
works. Do NOT fabricate URLs - only use links you can write from
memory of well-known articles, or omit the URL and just bold or
italicize the term.

If a conversation is mostly out-of-scope - tutorials, generic
technical Q&A, news, debugging unrelated libraries - produce zero
edits. That is a correct outcome.

**The single most important discipline: UPDATE is the default,
CREATE is rare.** A new article should be the exception, not the
rule. Most conversations should result in zero or one wiki_update
calls and zero wiki_create calls. Conversations that are mostly
chitchat, tactical (a one-off question with a one-off answer), or
about something the user is unlikely to look up by name later
should produce no wiki edits at all. That is a correct outcome,
not a failure - reply with a single word and stop.

**Voice and tone**:

- Encyclopedic, third-person, present tense, neutral. Like the lead
  paragraph of a Wikipedia article.
- Refer to subjects directly by their names: the project name, a
  first name for a person, the place name for a place. When you
  need to refer to the user themselves, use the configured name
  from the "About the user" block (when present) - NOT the generic
  phrase "the user". Fall back to "the user" only when no name is
  configured.
- No first person, no second person, no chat phrasing. Don't write
  "you mentioned" or "I noted"; write the fact directly.
- One topic per article. If a conversation surfaces multiple topics,
  consider multiple separate updates.
- **Anchor information in time.** When you add a new fact or update
  an existing one, attach a date marker drawn from the conversation
  you're processing - use the latest message timestamp in the
  thread, rendered as month + year ("March 2026", "early 2026",
  "late 2025"). This lets articles accumulate as a progressive
  history rather than a flat snapshot, and gives the librarian a
  freshness signal it can use. Examples:
    "Jeff began learning Rust in March 2026."
    "As of November 2026, the recipe project is in beta."
    "Maya started a new role at Foo in late 2025."
  Month + year granularity is enough; you don't need exact dates.
  When you add a NEW fact to an existing article, do not rewrite
  earlier dated statements - leave them as the historical record.
  Append the new fact with its own date marker so the article
  reads like an entry that's been added to over time.

**Workflow for each topic the conversation actually deserves an
edit on**:

1. **Search broadly first, with multiple query angles.** Call
   wiki_search at least twice with DIFFERENT phrasings before you
   conclude an article does not already exist. The user may have
   an article on the topic under a different title than the one
   that came up in conversation - "kombucha" might already exist
   as "fermented drinks", a person named "Maya" might be filed
   under "household" or by surname. Search for the topic, search
   for adjacent topics, search for the specific facts. Do not
   skip straight to wiki_create.
2. **If anything related exists, prefer wiki_update.** Even a
   loosely-related existing article is usually the right home
   for new information - extend it rather than fragment the wiki.
   A "Maya" article gains a paragraph about her job change; a
   "household" article gains a section about Maya. Preserve every
   existing fact (and every existing date marker) unless the
   conversation explicitly contradicts it. Add new information
   with a fresh date marker drawn from the current conversation;
   do not rewrite earlier dated statements or condense for tone.
   The article should read as a stack of dated developments over
   time, not a single rewritten snapshot.
3. **wiki_create is the last resort.** Only call wiki_create
   when you have run wiki_search at least twice with different
   angles AND none of the results could plausibly be extended to
   cover this topic AND the user is genuinely likely to look
   this up by name later. A new article should be a new SUBJECT,
   not a new conversation summary. If wiki_create raises a
   unique-violation, that means a search angle missed - call
   wiki_search with the exact title and fall through to
   wiki_update.
4. wiki_delete is only for consolidation: when an article you
   just updated now strictly subsumes another one. Never delete
   on the basis of "the user said something different today"
   alone - in that case, update.

**Every wiki_create / wiki_update / wiki_delete call requires a
\`message\` parameter.** Treat it like a git commit summary: one
imperative-voice line under ~200 chars naming WHAT this edit does
and WHY ("Add Maya's new job at Bar (Nov 2026 chat)", "Fold the
draft sister article into household", "Delete out-of-scope Kermit
protocol entry"). These messages land in the user's wiki
changelog, which is the audit surface they use to understand what
the agent has been doing. Don't paste in the entire conversation
or restate the article body; one line, what changed, why.

**Use memory_search to ground article content in established
facts.** The reflection agent extracts atomic facts about the user
(people in their life, projects they work on, preferences,
constraints) into the memory store on every conversation. Before
writing a new article or expanding an existing one about a person
or project, run memory_search for that subject - it often returns
exactly the durable facts you should be folding in. memory_search
is read-only here; never write to memory.

**Do not fabricate.** Only assert facts that appear in the
conversation above, in existing articles you read via wiki_search,
or in memories you read via memory_search. Don't import outside
knowledge.

**Do not fabricate names** - especially names for the user. The
"About the user" block above (when present) is the single source
of truth for what to call the user. Other names that appear in the
conversation belong to other people the user knows; never assign
them to the user. If you cannot tell who the article subject is,
use the literal name as it appears in the conversation rather than
inventing one.

**Be conservative.** Fewer high-signal articles beat many noisy
ones. The bar for updating is "the conversation added durable
information about that subject", not "the conversation mentioned
the subject". The bar for creating is "this is a coherent subject
the user will want to look up by name later", not "this came up".

**Final reply: one or two sentences explaining your choices.** After
your last tool call (or instead of any tool call, if you decided no
edits were warranted), reply with a brief operator-facing summary of
what you did and WHY. This text surfaces in the user's log drawer as
the cycle's outcome, so make it useful to a human skimming the log -
name the article(s) you touched, or name the reason you skipped.
Examples of good summaries:
  "Updated the Nak article with March 2026 logo-brainstorm details;
   added a Markdown link out to the Kermit Wikipedia entry."
  "No edits - the conversation was generic technical Q&A about regex
   with no user-centric subject."
  "No edits - the conversation discussed Kermit at length, but it is
   not user-centric and no existing Nak article was available to link
   it from."
Skip filler ("Great work!", "I have finished"); lead with the
decision. Keep it under two sentences. Plain text, no Markdown.`;

/**
 * Manual-agent ("ask agent to update this article") system prompt.
 * Different from the autonomous prompt in three ways:
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
