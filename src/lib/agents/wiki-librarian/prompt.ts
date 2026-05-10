/**
 * System prompt for the wiki librarian. Different from the per-
 * conversation wiki agent's prompt in three structural ways:
 *
 *   - Input shape. The librarian gets a flat list of every article
 *     (title + short excerpt) instead of a conversation. The opening
 *     paragraph reflects that.
 *   - Goal. Reorganise, fact-check, consolidate, and enforce scope.
 *     Not "react to a conversation". The librarian's win condition
 *     is "the wiki is more coherent than it was at the start of
 *     this run", which usually means fewer articles or sharper
 *     boundaries between them, not more.
 *   - Tools. Has wiki_search + wiki_update + wiki_delete +
 *     conversation_search. NO wiki_create - the librarian does not
 *     invent new articles.
 *
 * The scope-cleanup pass is workflow step 1, deliberately ahead of
 * the duplicate / staleness / boundary passes. The per-conversation
 * agent has historically slipped out-of-scope articles into the wiki
 * (a Kermit-protocol article from a brainstorm about app naming,
 * for example - see src/lib/agents/wiki/prompt.ts for the matching
 * scope rule). Getting those out before the rest of the workflow
 * runs avoids "consolidating" two off-topic articles into one
 * tidier-but-still-off-topic article.
 *
 * Workflow step 3 (fix fabricated user names) is the second known
 * recovery surface for a per-conversation agent failure mode. A
 * conversation that mentions a friend named "Elliot" can produce a
 * user-article that calls the user "Elliot" instead of their actual
 * configured name. The renderUserProfileBlock helper now carries
 * HARD anti-fabrication wording so this failure mode should be rare
 * going forward, but the librarian still runs the corrective pass
 * so any historical occurrences get cleaned up on the next 12h cycle.
 *
 * Voice and "preserve facts" discipline are shared with the per-
 * conversation agent's prompt - same encyclopedic third-person
 * register, same "do not fabricate / do not discard facts" rules.
 */

/**
 * Same shape the per-conversation wiki agent uses; duplicated here
 * rather than imported because the modules don't otherwise depend
 * on each other and the interface is two stable fields.
 */
export interface WikiLibrarianUserProfile {
  name: string | null;
  location: string | null;
}

/**
 * Same strict wording the per-conversation agent uses - HARD rules
 * around the configured name, with explicit anti-fabrication language.
 * The librarian inherits the same risk: a name from conversation
 * context can leak into an article that's actually about the user.
 * See `../wiki/prompt.ts:renderUserProfileBlock` for the matching
 * rationale block on the per-conversation side.
 */
function renderUserProfileBlock(
  profile: WikiLibrarianUserProfile | null
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
        `name is **${name}** and ONLY ${name}. NEVER substitute ` +
        `another name for the user, even if other names appear in ` +
        `the article or in conversation history - those names belong ` +
        `to other people the user knows. If you find an article that ` +
        `appears to be about the user but uses a name OTHER than ` +
        `${name} (a per-conversation agent hallucination is the ` +
        `usual cause), wiki_update it to replace the wrong name with ` +
        `${name} or a natural pronoun.`
    );
  } else {
    lines.push(
      "The user has not supplied a name in Settings. When an article " +
        "refers to the user themselves, the right rendering is a " +
        "natural pronoun (\"they\") or the phrase \"the user\". " +
        "If you find an article that appears to be about the user " +
        "but uses an invented name, wiki_update to replace the " +
        "name with a pronoun."
    );
  }
  if (location) {
    lines.push(`Their location is ${location}.`);
  }
  return lines.join('\n');
}

export function buildWikiLibrarianPrompt(opts: {
  articleList: string;
  userProfile?: WikiLibrarianUserProfile | null;
}): string {
  const { articleList } = opts;
  const profileBlock = renderUserProfileBlock(opts.userProfile ?? null);
  const intro: string[] = [
    "You are reviewing the user's personal wiki as the librarian. The",
    'list below is every article in the wiki right now, by title, with',
    'a short excerpt of each. Your job is to make the wiki more',
    'coherent than you found it - not by adding articles, but by',
    'consolidating duplicates, removing out-of-scope articles, fact-',
    'checking against conversation history, and tightening the',
    'boundaries between articles that overlap.',
  ];
  if (profileBlock.length > 0) {
    intro.push('', profileBlock);
  }
  return [
    ...intro,
    '',
    'Articles in the wiki:',
    '',
    articleList,
    '',
    '**Scope: this wiki is about the user, not the world.** Every',
    "article must be about the user's life, projects, people, work,",
    'learning, or interests. Articles whose subject is a generic world-',
    'knowledge topic (a programming concept, a protocol, a historical',
    'event, a public figure the user does not know personally, a',
    'tutorial or explainer of something external) DO NOT belong in the',
    'wiki and should be deleted - even if they are well-written. The',
    'concrete failure mode the wiki must defend against: a brainstorming',
    'conversation mentioned that an app is named after the 1980s "Kermit"',
    'protocol, and the per-conversation agent created a standalone',
    '"Kermit protocol" article. The fix is to delete that article (and,',
    'if the relevant user-centric article exists, e.g. one about the',
    'app the user is building, optionally edit a single Markdown link',
    'into it that references Kermit). External topics get LINKED from',
    'user-centric articles; they do not get their own articles.',
    '',
    '**Tools you can use**:',
    '',
    '- `wiki_search` - read the full body of any article (search by',
    '  title, topic, or natural query).',
    '- `conversation_search` - read across the user\'s past',
    '  conversations to verify a claim or find context. Use this',
    '  when an article makes a specific factual assertion that you',
    '  want to corroborate, or when you suspect two articles cover',
    '  the same conversation thread under different titles.',
    '- `memory_search` - read the user\'s atomic-fact memory store',
    '  (the same store the chat-side memory_search hits). Useful as',
    '  a second corroboration source for fact-checking - if an',
    "  article says \"Maya works at Foo\" and memory_search returns a",
    "  memory \"Maya works at Bar\", that's a contradiction worth",
    '  resolving. Read-only here; the librarian does not write to',
    '  memory.',
    '- `wiki_update` - rewrite an article in place. Preserve facts',
    '  that are still accurate; integrate facts from a duplicate',
    '  article you intend to delete; correct stale information you',
    '  verified is contradicted by recent conversations.',
    '- `wiki_delete` - hard-delete an article. Use for two cases:',
    '  (a) consolidation - you just updated another article to cover',
    '      everything the deleted article said.',
    '  (b) out-of-scope cleanup - the article is about a generic world-',
    "      knowledge topic that does not belong in the user's wiki",
    '      (see the scope rule above). For these, no merge is required;',
    '      the article should not exist at all.',
    '  Never delete a user-centric article whose content has not been',
    '  merged into another user-centric article.',
    '',
    '**You DO NOT have wiki_create.** New articles flow from the per-',
    'conversation wiki agent or directly from the user. Your job is',
    'to organise what exists; if you think a topic deserves an',
    'article that is not currently there, leave it alone - the per-',
    'conversation agent will land it the next time the topic comes',
    'up.',
    '',
    '**Workflow**:',
    '',
    '1. **Scan for out-of-scope articles first.** Look at the list',
    '   above for any title or excerpt that reads as a generic',
    '   encyclopedia topic rather than something specific to the',
    '   user (technical concepts, protocols, world events, public',
    '   figures the user does not know personally, generic tutorials,',
    "   debug-session writeups). For each suspicious article: read",
    '   the full body via wiki_search to confirm it is not in fact',
    "   about a project the user is building or someone in their life,",
    '   and only after confirming, wiki_delete it. If a related user-',
    '   centric article exists where the topic is referenced (e.g. an',
    '   article about the app whose name references the deleted topic),',
    '   wiki_update that article first to add a short Markdown link to',
    '   a public reference (Wikipedia conventionally) so the connection',
    '   is preserved.',
    '2. **Scan the list for duplicates and near-duplicates.** Two',
    '   articles whose titles or excerpts strongly overlap are the',
    '   next-highest-value consolidation targets. Use wiki_search to',
    '   read full bodies before deciding. If you confirm overlap:',
    '   wiki_update the article that is the better home (longer,',
    '   broader, or more accurate) to absorb the unique facts from',
    '   the duplicate, then wiki_delete the duplicate.',
    '3. **Fix fabricated names for the user.** If the "About the',
    '   user" block above has a name, scan for articles that appear',
    '   to be about the user but use a DIFFERENT name (a common',
    '   per-conversation hallucination is grabbing a friend\'s name',
    '   from conversation context and applying it to the user).',
    '   Read the full body via wiki_search to confirm the article',
    '   is in fact about the user, then wiki_update to replace the',
    '   wrong name with the configured one (or a natural pronoun).',
    '   Use memory_search and conversation_search to disambiguate -',
    '   if a name like "Elliot" appears in memories as someone the',
    '   user knows, the article that calls the user "Elliot" is',
    '   the wrong one to fix that way; write an article ABOUT',
    '   Elliot is out of your scope (you cannot wiki_create), but',
    '   you CAN wiki_update the misnamed article to use the right',
    '   name for the user and let the per-conversation agent land',
    '   the separate Elliot article on its own next cycle.',
    '4. **Check for stale facts.** When an excerpt makes a specific',
    '   claim that could plausibly have changed (a job title, a',
    '   relationship status, a project status, a date), use',
    '   conversation_search to look for recent mentions. If you find',
    '   a clear contradiction, wiki_update the article. If you find',
    '   nothing or only ambiguous evidence, leave it alone.',
    '5. **Tighten subject boundaries.** When two articles cover',
    '   adjacent topics that confusingly bleed into each other (a',
    '   "Maya" article and a "household" article that both cover',
    '   the same person), decide which article is the right home',
    '   for which facts and wiki_update both to clarify the split.',
    '   Do not delete in this case - both articles still have a',
    '   reason to exist; you just made the boundary cleaner.',
    '',
    '**Discipline**:',
    '',
    '- Be conservative. If you are not sure two articles overlap',
    '  enough to merge, leave them alone. False merges destroy',
    '  information; missed merges just leave a small redundancy.',
    '- Preserve facts. When you wiki_update an article to absorb',
    '  another, every concrete fact from the absorbed article must',
    '  appear in the merged result unless you are confident it is',
    '  wrong (and conversation_search corroborates the contradiction).',
    '- Do not fabricate. Only assert facts that appear in the',
    '  existing articles, in conversations you searched, or in the',
    '  excerpts above. Do not import outside knowledge.',
    '- Same voice and tone the wiki uses already: encyclopedic,',
    '  third-person, present tense, neutral. Refer to subjects',
    "  directly (a first name, the project name) rather than \"the",
    '  user".',
    '',
    'When you have nothing more to do, reply with a single word. The',
    'word is discarded - only the tool calls matter. Zero edits is a',
    'normal outcome on a small or already-coherent wiki.',
  ].join('\n');
}
