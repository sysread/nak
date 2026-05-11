/**
 * The wiki-recall agent's user-turn instruction. Sibling of
 * `agents/recall/prompt.ts` (memories) and
 * `agents/conversation_recall/prompt.ts` (prior threads), one layer
 * over. Appended as the final user turn of a messages array whose
 * prefix is the live conversation trimmed to the last user turn; the
 * model reads the prior assistant turns as itself, then switches
 * modes - its job is to pull relevant context out of the user's wiki
 * (flat encyclopedic articles ABOUT the user's life), not to reply.
 *
 * Why a third recall surface: the wiki is the longest-form, most
 * curated layer of persistent user data. Memories carry atomic facts;
 * conversations carry the threads they were worked out in; the wiki
 * carries the encyclopedic synthesis - "what is X (in the user's
 * life)" articles that span many conversations. None of the three
 * substitutes for the others. A model trying to remember "did we
 * already work through the gardening project?" wants memory + prior
 * conversations; a model trying to read up on the gardening project
 * itself (so it can speak to the user's actual setup, plants, plans)
 * wants the wiki article.
 *
 * Same EXPLICIT vs IMPLICIT mode distinction as memory recall. The
 * wiki is reachable from the main chat only via wiki_search; when the
 * user explicitly asks "what does my wiki say about X" the bar should
 * be low. When the main model invokes wiki_recall as a reflex on a
 * topic boundary, the bar should be high - parroting the conversation
 * back to itself is worse than the empty signal.
 *
 * Same `reason` field on the empty signal as the other recall
 * prompts: a "wiki_recall keeps emitting empty" loop has no
 * diagnostic signal without it.
 *
 * Framing notes that differ from memory / conversation recall:
 *
 *   - Search target is the user's wiki. Articles are encyclopedic
 *     prose ABOUT topics in the user's life (people, places,
 *     projects, ongoing experiments) and never auto-injected. The
 *     wiki agent assembles articles from multiple conversations, so
 *     a single wiki paragraph often summarises content spread across
 *     many threads - higher signal density than either memories or
 *     conversation summaries when the topic is one the user has
 *     invested in.
 *
 *   - Optional topic hint. When the main assistant calls
 *     `wiki_recall({topic: "the herb garden"})`, the topic string is
 *     appended to the prompt so the agent biases its first
 *     `wiki_search` query toward it. Absent, the agent infers from
 *     the conversation above.
 *
 *   - First-person voice ("the wiki has a long entry on this -
 *     they're growing X, Y, Z; harvest schedule is W"), same as the
 *     other recall agents. The main model reads the note as its own
 *     thought.
 */
const BASE_PROMPT = [
  "You've just read the conversation above. Step out of the role of the",
  "main assistant - this time, you're not replying to the user. Your job",
  "is to pull relevant context out of the user's wiki - flat encyclopedic",
  'articles ABOUT the user (their projects, the people in their life,',
  'places they live or visit, things they are learning, their work,',
  'ongoing experiments).',
  '',
  'First, decide which mode you are in by reading the latest user turn:',
  '',
  '  EXPLICIT recall: the user asked the main model directly about an',
  '  article in their wiki - "what does my wiki say about X?", "pull',
  '  up the article on Y", "remind me what we have written about Z".',
  '  The user wants the article surfaced. Bar is LOW: the relevance',
  '  test IS the question, so do not also filter on "would it change',
  '  how the main model frames the answer." Surface what you find with',
  '  enough detail to answer the user.',
  '',
  '  IMPLICIT recall: the user asked a regular question and the main',
  '  model called recall hoping context from an article would help.',
  '  Bar is HIGH: only emit when an article adds CONCRETE DETAIL the',
  '  main model would benefit from. A note that just says "the wiki',
  '  has an article on this" without adding detail wastes tokens and',
  '  is worse than no note at all.',
  '',
  'Two channels worth surfacing in either mode:',
  '',
  '  (1) DETAILS from articles the main model would benefit from',
  '      knowing - the actual subject matter (people involved, places,',
  '      plans, ongoing state, decisions captured in the article). In',
  '      EXPLICIT mode, surface what answers the user. In IMPLICIT',
  '      mode, only emit when the detail is concrete and not already',
  '      in-thread.',
  '',
  '  (2) CALIBRATION about how deeply the user has invested in this',
  '      topic - a long, detailed article on something signals "the',
  '      user is past the introduction here, do not over-explain";',
  '      a stub article signals "the user has been collecting notes,',
  '      not synthesising yet." Do NOT list article titles for their',
  '      own sake; only emit calibration that would change level/depth.',
  '',
  'Workflow:',
  '',
  '1. Pick the mode (above), then use `wiki_search` - usually more than',
  '   once, with different queries - to find candidate articles. In',
  '   EXPLICIT mode, paraphrase what the user asked. In IMPLICIT mode,',
  "   paraphrase the user's actual topic. Each result carries the full",
  '   article body - read it to judge relevance.',
  '2. Cross-check against the conversation. EXPLICIT: do not filter',
  '   (the user asked, surface it). IMPLICIT: drop articles that do',
  '   not add concrete detail beyond what is already in-thread; drop',
  '   calibration that would not change level/depth.',
  '3. Assimilate the remaining signal into a short first-person note',
  "   in the main assistant's voice (\"the wiki has a detailed entry",
  '   on this - X, Y, Z", "we have a stub article on this - just',
  '   notes that the user is starting to..."). Blend DETAILS and',
  '   CALIBRATION when both have signal: one short sentence each. Do',
  '   not attribute to a third party; this is a note you are writing',
  '   to yourself.',
  '',
  'Reply with JSON in one of exactly these two shapes:',
  '',
  '- `{"kind": "none", "reason": "<short diagnostic>"}` when nothing is',
  '  worth injecting. The `reason` is REQUIRED and is for diagnostics',
  '  - keep it short and concrete ("no wiki articles matched any query',
  '  I tried", "found N articles but none added concrete detail beyond',
  '  the current conversation", "the user asked about X and no article',
  '  mentions X"). Vague reasons defeat the purpose.',
  '',
  '- `{"kind": "note", "note": "<short first-person paragraph>"}` with',
  '  the assimilated recall. Keep `note` under ~400 characters - one',
  '  tight paragraph, not a bulleted list.',
  '',
  'Do not emit any other keys. Do not wrap the JSON in prose or a code',
  'fence.',
].join('\n');

/**
 * Compose the full instruction. When the main assistant passed a
 * topic hint, suffix the prompt with a "specifically this" line so
 * the agent's first few search queries bias toward it rather than
 * re-deriving the topic from the conversation. Absent topic is the
 * common case - the agent reads the conversation above and makes
 * its own judgment.
 */
export function buildWikiRecallPrompt(topic?: string | null): string {
  const clean = typeof topic === 'string' ? topic.trim() : '';
  if (clean.length === 0) return BASE_PROMPT;
  return (
    BASE_PROMPT +
    '\n\n' +
    `The main assistant flagged this topic specifically: ${clean}`
  );
}
