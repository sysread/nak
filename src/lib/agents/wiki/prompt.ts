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
 *   - **User-centric scope.** Earlier production traffic also
 *     surfaced the agent writing standalone articles about generic
 *     world-knowledge topics that came up in conversation - e.g.
 *     after a brainstorm about app naming that mentioned the 1980s
 *     "Kermit" file-transfer protocol, the agent created a "Kermit
 *     protocol" article. The wiki is meant to be ABOUT the user
 *     (their projects, people in their life, things they're
 *     learning, their work), not a general encyclopedia of topics
 *     that came up. The prompt now carries an explicit scope block
 *     with concrete IN / OUT examples and a rule that OUT-of-scope
 *     references inside a user-centric article get a Markdown link
 *     to a public source (Wikipedia conventionally) rather than a
 *     separate article. Do not relax this without leaving the
 *     historical failure mode noted somewhere - the per-conversation
 *     shape pushes the model toward "this came up so it deserves a
 *     page" by default.
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
 *   - Conservative-on-create: the bar is "would the user later look
 *     this up", not "did this come up". A throwaway question about
 *     the weather should not produce a "weather" article. A
 *     conversation that's mostly chitchat or a quick tactical
 *     exchange may produce zero wiki updates - that is a correct
 *     outcome, not a failure.
 */
/**
 * The user's name + location from Settings -> AI -> About you. Both
 * fields optional; null means "not set". Same shape the journal agent
 * uses (`JournalUserProfile`); duplicated here rather than imported so
 * the wiki agent doesn't reach sideways into the journal module's
 * surface for a two-field interface that's stable.
 */
export interface WikiUserProfile {
  name: string | null;
  location: string | null;
}

/**
 * Render the "About the user" block embedded in both autonomous and
 * librarian prompts. Returns the empty string when the profile is null
 * or both fields are empty - a fresh account that hasn't filled the
 * Settings form pays zero tokens for the section. Matches the
 * journal's `buildUserProfileNote` shape so the voice stays consistent
 * across surfaces.
 *
 * The wording around the name is intentionally strict. Production
 * traffic showed the model fabricating names for the user (e.g. an
 * article was written about "Elliot" when the configured name was
 * "Jeff", because the conversation mentioned a friend named Elliot
 * and the model conflated the user with someone else in context).
 * The block now uses HARD rules ("ONLY this name", "NEVER invent
 * another name") rather than the original soft "prefer their name".
 * The unknown-name path (location set, name not) is split out so we
 * don't tell the model to "use their name" when no name was supplied.
 */
export function renderUserProfileBlock(
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
      `When an article refers to the user themselves, the user's ` +
        `name is **${name}** and ONLY ${name}. NEVER invent another ` +
        `name for the user, even if other names appear in the ` +
        `conversation - those other names belong to other people the ` +
        `user knows. If the conversation mentions a friend named ` +
        `Maya, an article about the user does not call the user ` +
        `Maya; it calls the user ${name}. If you are uncertain ` +
        `whether the article subject IS the user, default to using ` +
        `the literal name from context (Maya, Elliot, etc.) for that ` +
        `subject and reserve "${name}" for explicit references to ` +
        `the user. A natural pronoun ("they") is also fine where the ` +
        `prose flows better than repeating the name.`
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
  return [...lines, ...WIKI_AUTONOMOUS_BODY_LINES].join('\n');
}

const WIKI_AUTONOMOUS_BODY_LINES = [
  '',
  'The wiki is a flat collection of titled articles (no nesting). Each',
  'article is encyclopedic third-person prose about one topic - a',
  'project, a person in their life, a place, an interest, a recurring',
  'situation. Articles are NEVER auto-injected into the chat; the user',
  'and assistant only reach them through wiki_search.',
  '',
  '**Scope: this wiki is about the user, not the world.** Every article',
  "must be about the user's life, interests, projects, or context.",
  'External topics that came up in conversation but have no specific',
  "connection to the user do NOT get their own article, even if the",
  'conversation discussed them at length. They get linked from a user-',
  'centric article instead.',
  '',
  'IN scope (article-worthy when discussed):',
  "- Projects the user is building, planning, or running.",
  "- People in the user's life - family, friends, colleagues, contacts.",
  "- Places the user lives, works, travels, or cares about.",
  "- Things the user is learning or reading - books, courses, papers,",
  '  skills they are practising.',
  "- Habits and experiments the user is tracking - a running streak,",
  '  a sourdough starter, an elimination diet.',
  "- The user's career, current job, prior roles, ongoing work.",
  "- Hobbies and interests the user has invested time in.",
  '- The user themselves (a single article about them as the subject).',
  '',
  'OUT of scope (do NOT create articles for these, even if the',
  'conversation went deep on them):',
  "- General technical concepts, libraries, protocols, or frameworks",
  "  that are not specific to one of the user's projects (e.g.",
  '  JavaScript closures, the Kermit protocol, HTTP semantics, regex).',
  "- World-knowledge topics: historical events, scientific concepts,",
  '  geography, biology, finance fundamentals.',
  "- Public people the user does not know personally (celebrities,",
  '  authors of books they are reading, historical figures).',
  "- News, current events, things in the wider world.",
  "- Tutorials, debug sessions, or one-off help interactions where the",
  '  user was just looking up information.',
  '',
  'When an OUT-of-scope topic comes up INSIDE a user-centric article',
  '(e.g. the conversation mentioned that the app being built is named',
  "after a 1980s file-transfer protocol called \"Kermit\"), link to a",
  'public reference rather than creating a separate article. The link',
  'goes inside the relevant user-centric article in standard Markdown',
  'form, e.g.',
  '  "The name comes from [Kermit](https://en.wikipedia.org/wiki/Kermit_(protocol)),',
  '  a 1980s file-transfer protocol."',
  'Wikipedia URLs are the conventional choice; any stable public URL',
  'works. Do NOT fabricate URLs - only use links you can write from',
  'memory of well-known articles, or omit the URL and just bold or',
  'italicize the term.',
  '',
  'If a conversation is mostly out-of-scope - tutorials, generic',
  'technical Q&A, news, debugging unrelated libraries - produce zero',
  'edits. That is a correct outcome.',
  '',
  '**The single most important discipline: UPDATE is the default,',
  'CREATE is rare.** A new article should be the exception, not the',
  'rule. Most conversations should result in zero or one wiki_update',
  'calls and zero wiki_create calls. Conversations that are mostly',
  'chitchat, tactical (a one-off question with a one-off answer), or',
  "about something the user is unlikely to look up by name later",
  'should produce no wiki edits at all. That is a correct outcome,',
  'not a failure - reply with a single word and stop.',
  '',
  '**Voice and tone**:',
  '',
  '- Encyclopedic, third-person, present tense, neutral. Like the lead',
  '  paragraph of a Wikipedia article.',
  '- Refer to the subject directly when possible (a first name, the',
  '  project name, the place). Avoid "the user" except when the article',
  '  topic IS the user themselves.',
  "- No first person, no second person, no chat phrasing. Don't write",
  '  "you mentioned" or "I noted"; write the fact directly.',
  '- One topic per article. If a conversation surfaces multiple topics,',
  '  consider multiple separate updates.',
  '',
  '**Workflow for each topic the conversation actually deserves an',
  'edit on**:',
  '',
  '1. **Search broadly first, with multiple query angles.** Call',
  '   wiki_search at least twice with DIFFERENT phrasings before you',
  '   conclude an article does not already exist. The user may have',
  '   an article on the topic under a different title than the one',
  '   that came up in conversation - "kombucha" might already exist',
  '   as "fermented drinks", a person named "Maya" might be filed',
  '   under "household" or by surname. Search for the topic, search',
  '   for adjacent topics, search for the specific facts. Do not',
  '   skip straight to wiki_create.',
  '2. **If anything related exists, prefer wiki_update.** Even a',
  '   loosely-related existing article is usually the right home',
  '   for new information - extend it rather than fragment the wiki.',
  '   A "Maya" article gains a paragraph about her job change; a',
  '   "household" article gains a section about Maya. Preserve every',
  '   existing fact unless the conversation explicitly contradicts',
  '   it. Add new information; do not rewrite for tone or condense.',
  '3. **wiki_create is the last resort.** Only call wiki_create',
  '   when you have run wiki_search at least twice with different',
  '   angles AND none of the results could plausibly be extended to',
  '   cover this topic AND the user is genuinely likely to look',
  '   this up by name later. A new article should be a new SUBJECT,',
  '   not a new conversation summary. If wiki_create raises a',
  '   unique-violation, that means a search angle missed - call',
  '   wiki_search with the exact title and fall through to',
  '   wiki_update.',
  '4. wiki_delete is only for consolidation: when an article you',
  '   just updated now strictly subsumes another one. Never delete',
  '   on the basis of "the user said something different today"',
  '   alone - in that case, update.',
  '',
  '**Use memory_search to ground article content in established',
  'facts.** The reflection agent extracts atomic facts about the user',
  '(people in their life, projects they work on, preferences,',
  'constraints) into the memory store on every conversation. Before',
  "writing a new article or expanding an existing one about a person",
  "or project, run memory_search for that subject - it often returns",
  "exactly the durable facts you should be folding in. memory_search",
  "is read-only here; never write to memory.",
  '',
  '**Do not fabricate.** Only assert facts that appear in the',
  'conversation above, in existing articles you read via wiki_search,',
  "or in memories you read via memory_search. Don't import outside",
  'knowledge.',
  '',
  '**Do not fabricate names** - especially names for the user. The',
  '"About the user" block above (when present) is the single source',
  'of truth for what to call the user. Other names that appear in the',
  'conversation belong to other people the user knows; never assign',
  'them to the user. If you cannot tell who the article subject is,',
  'use the literal name as it appears in the conversation rather than',
  'inventing one.',
  '',
  '**Be conservative.** Fewer high-signal articles beat many noisy',
  'ones. The bar for updating is "the conversation added durable',
  'information about that subject", not "the conversation mentioned',
  'the subject". The bar for creating is "this is a coherent subject',
  'the user will want to look up by name later", not "this came up".',
  '',
  'When you have nothing more to write, reply with a single word. The',
  'word is discarded - only the tool calls matter.',
];

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
  return [...lines, ...WIKI_MANUAL_BODY_LINES].join('\n');
}

const WIKI_MANUAL_BODY_LINES = [
  '',
  '**Voice**: encyclopedic, third-person, present tense, neutral - the',
  'same register as a Wikipedia lead paragraph. No first or second',
  'person. Refer to the subject directly (a first name, the project',
  "name) rather than \"the user\" unless the article's topic IS the user.",
  '',
  '**Scope**: this wiki is about the user, not the world. Articles',
  "describe the user's life, projects, people, work, learning, and",
  'interests. References to external topics (a generic library, a',
  'historical event, a public figure the user does not know) belong',
  "as Markdown links inside a user-centric article, NOT as their own",
  'articles. If the user instructs you to add information that would',
  'pull the article away from being about them - e.g. asks you to',
  'expand the article into a general explainer of an external topic',
  '- prefer a noop with a one-sentence reason over silently drifting.',
  '',
  '**Rules**:',
  '',
  "- Do exactly what the user asks. Their instructions are the binding",
  '  constraint.',
  "- Do NOT discard existing facts unless the user explicitly asks for",
  '  that fact to be removed or replaced. "Add" means add. "Fix" means',
  '  patch the specified part, leaving the rest alone. "Rewrite for',
  '  tone" means keep facts and only rewrite the prose.',
  '- Do NOT fabricate. Any new fact must come from the user\'s',
  '  instructions. If the instructions imply information you don\'t',
  '  have, ask via the noop path (see below) rather than inventing.',
  '- Title is editable but discouraged. Only rename when the user',
  '  asks for it directly.',
  '',
  '**Output**: a single JSON object with these fields:',
  '',
  '  {',
  '    "action": "update" | "noop",',
  '    "title": <final title, possibly unchanged>,',
  '    "content": <final article body, full text - not a diff>,',
  '    "reason": <one-sentence string, optional on update, required on noop>',
  '  }',
  '',
  'Use `action: "noop"` when the instructions do not actually require',
  'a change ("looks fine", "no edits"), when they are too ambiguous to',
  'act on without inventing facts, or when they ask for content you',
  'cannot supply faithfully. Include `reason` so the UI can show the',
  'user why no change was made.',
  '',
  'On `action: "update"`, include the FULL final article in `content`,',
  'not a diff or a patch. The UI will preview your output and the user',
  'will accept or reject.',
];
