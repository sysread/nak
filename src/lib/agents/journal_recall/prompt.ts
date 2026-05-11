/**
 * The journal-recall agent's user-turn instruction. Fourth sibling
 * of memory recall, conversation recall, and wiki recall. Appended
 * as the final user turn of a messages array whose prefix is the
 * live conversation trimmed to the last user turn; the model reads
 * the prior assistant turns as itself, then switches modes - its job
 * is to pull relevant context out of the user's daily journal (dated
 * reflections summarising threads + user-written entries), not to
 * reply.
 *
 * Why a fourth recall surface: the journal is the user's reflective
 * archive - dated entries that summarise what they processed in a
 * given day. Memories carry atomic facts; conversations carry the
 * topical threads those facts were worked out in; the wiki carries
 * the encyclopedic synthesis ABOUT topics. The journal carries
 * something different: the EMOTIONAL / REFLECTIVE arc through time.
 * When a user revisits a hard topic ("I have been thinking again
 * about X"), the journal is the right surface for "we have already
 * been here, here's how it has landed before."
 *
 * Same EXPLICIT vs IMPLICIT mode distinction as the other recall
 * prompts. When the user explicitly asks what their journal says,
 * the bar should be low. When the main model invokes journal_recall
 * as a reflex on a topic boundary, the bar should be high - the
 * journal-as-context play is "we have been here before, here is what
 * it has felt like," NOT "list everything dated from May."
 *
 * Same `reason` field on the empty signal as the other recall
 * prompts: a "journal_recall keeps emitting empty" loop has no
 * diagnostic signal without it.
 *
 * Framing notes that differ from the other recall surfaces:
 *
 *   - Search target is the journal. Entries are dated and carry
 *     mood / topics / people facets, so the agent can lean on
 *     temporal arc ("the user worked through X across April") and
 *     emotional calibration ("this topic carried tentative-low mood
 *     last time") in addition to topical content.
 *
 *   - The journal is the right surface for REFLECTIVE topics
 *     specifically. If the conversation is operational ("help me
 *     write a regex"), the journal almost never has signal and the
 *     agent should emit the empty signal quickly. If the
 *     conversation is reflective ("I have been thinking about my
 *     dad again"), the journal is exactly where to look.
 *
 *   - Optional topic hint. When the main assistant calls
 *     `journal_recall({topic: "my dad"})`, the topic string is
 *     appended to the prompt so the agent biases its first
 *     `journal_search` query toward it. Absent, the agent infers
 *     from the conversation above.
 *
 *   - First-person voice ("I remember the user worked through this
 *     in April - the entries from that week carried..."), same as
 *     the other recall agents. The main model reads the note as
 *     its own thought.
 */
const BASE_PROMPT = [
  "You've just read the conversation above. Step out of the role of the",
  "main assistant - this time, you're not replying to the user. Your job",
  "is to pull relevant context out of the user's daily journal - dated",
  'reflective entries summarising what they processed in a given day.',
  '',
  'First, decide which mode you are in by reading the latest user turn:',
  '',
  '  EXPLICIT recall: the user asked the main model directly about',
  '  their journal - "what does my journal say about X?", "when did',
  '  I last write about Y?", "remind me how I felt about Z last',
  '  month". The user wants journal entries surfaced. Bar is LOW:',
  '  the relevance test IS the question, so do not also filter on',
  '  "would it change how the main model frames the answer." Surface',
  '  what you find with enough detail to answer the user.',
  '',
  '  IMPLICIT recall: the user asked a regular question and the main',
  '  model called recall hoping context from journal entries would',
  '  help. Bar is HIGH: only emit when prior entries add CONCRETE',
  '  DETAIL or REFLECTIVE ARC the main model would benefit from. A',
  '  note that just says "the user has journal entries on this"',
  '  without adding detail wastes tokens.',
  '',
  '  The journal is the RIGHT surface for reflective conversations and',
  '  the WRONG surface for operational ones. If the latest user turn',
  '  is "help me write a regex" or "what time is it in Lisbon", the',
  '  journal almost certainly has no signal - emit the empty signal',
  '  with a reason that names the operational framing. Save the',
  '  search budget for when the topic carries an emotional / reflective',
  '  shape.',
  '',
  'Two channels worth surfacing in either mode:',
  '',
  '  (1) DETAILS from prior entries the main model would benefit from -',
  "      the actual material the user wrote about, what they were",
  '      processing, conclusions or hard observations they captured.',
  '      In EXPLICIT mode, surface what answers the user. In IMPLICIT',
  '      mode, only emit when the detail is concrete and not already',
  '      in-thread.',
  '',
  '  (2) CALIBRATION about the reflective arc - has the user been here',
  '      before, how did it feel, what was unresolved, what they tried.',
  '      Mood facets on entries help here ("entries from that week',
  '      carried tentative-low mood"). "Would it change how the main',
  '      model pitches the answer?" - if the user has worked through',
  '      this before, the main model should pick up where they left',
  '      off, not start from scratch.',
  '',
  'Workflow:',
  '',
  '1. Pick the mode (above), then use `journal_search` - usually more',
  '   than once, with different queries - to find candidate entries.',
  '   In EXPLICIT mode, paraphrase what the user asked. In IMPLICIT',
  "   mode, paraphrase the user's actual topic. Each result carries",
  '   the full entry body plus topics / mood / people facets - read',
  '   them to judge relevance.',
  '2. Cross-check against the conversation. EXPLICIT: do not filter',
  '   (the user asked, surface it). IMPLICIT: drop entries that do',
  '   not add concrete detail beyond what is already in-thread; drop',
  '   calibration that would not change level/depth.',
  '3. Assimilate the remaining signal into a short first-person note',
  "   in the main assistant's voice (\"I remember the user worked",
  '   through this in April - the entries from that week carried...",',
  '   "we have been here before; the user landed on..."). Blend',
  '   DETAILS and CALIBRATION when both have signal: one short',
  '   sentence each. Do not attribute to a third party; this is a',
  '   note you are writing to yourself.',
  '',
  'Reply with JSON in one of exactly these two shapes:',
  '',
  '- `{"kind": "none", "reason": "<short diagnostic>"}` when nothing is',
  '  worth injecting. The `reason` is REQUIRED and is for diagnostics',
  '  - keep it short and concrete ("operational topic, journal has no',
  '  signal", "no journal entries matched any query I tried", "found',
  '  N entries but none added concrete detail beyond the current',
  '  conversation"). Vague reasons defeat the purpose.',
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
export function buildJournalRecallPrompt(topic?: string | null): string {
  const clean = typeof topic === 'string' ? topic.trim() : '';
  if (clean.length === 0) return BASE_PROMPT;
  return (
    BASE_PROMPT +
    '\n\n' +
    `The main assistant flagged this topic specifically: ${clean}`
  );
}
