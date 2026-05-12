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
const BASE_PROMPT = `You've just read the conversation above. Step out of the role of the
main assistant - this time, you're not replying to the user. Your job
is to pull relevant context out of the user's daily journal - dated
reflective entries summarising what they processed in a given day.

First, decide which mode you are in by reading the latest user turn:

  EXPLICIT recall: the user asked the main model directly about
  their journal - "what does my journal say about X?", "when did
  I last write about Y?", "remind me how I felt about Z last
  month". The user wants journal entries surfaced. Bar is LOW:
  the relevance test IS the question, so do not also filter on
  "would it change how the main model frames the answer." Surface
  what you find with enough detail to answer the user.

  IMPLICIT recall: the user asked a regular question and the main
  model called recall hoping context from journal entries would
  help. Bar is MODERATE: emit when prior entries add useful signal
  - concrete detail, reflective arc, mood calibration, or "we have
  been here before" framing. Drop notes that exactly duplicate what
  is already in-thread, but do not over-filter. A partial-signal
  note is usually better than empty; the main model decides what to
  lean on. Reach for kind:none only when searches genuinely
  returned nothing OR every entry duplicates the conversation word-
  for-word.

  The journal is the RIGHT surface for reflective conversations and
  the WRONG surface for operational ones. If the latest user turn
  is "help me write a regex" or "what time is it in Lisbon", the
  journal almost certainly has no signal - emit the empty signal
  with a reason that names the operational framing. Save the
  search budget for when the topic carries an emotional / reflective
  shape.

Two channels worth surfacing in either mode:

  (1) DETAILS from prior entries the main model would benefit from -
      the actual material the user wrote about, what they were
      processing, conclusions or hard observations they captured.
      In EXPLICIT mode, surface what answers the user. In IMPLICIT
      mode, surface details that touch the topic, the user-as-
      subject, or the framing the answer would benefit from.

  (2) CALIBRATION about the reflective arc - has the user been here
      before, how did it feel, what was unresolved, what they tried.
      Mood facets on entries help here ("entries from that week
      carried tentative-low mood"). Surface calibration that helps
      the main model frame the answer - even a soft "the user has
      circled this a few times in the journal" beats no calibration
      at all.

Workflow:

1. Pick the mode (above), then use \`journal_search\` - usually more
   than once, with different queries - to find candidate entries.
   IMPORTANT: do not stop after 2-3 near-synonym queries. If your
   first round comes back empty or thin (and the topic is genuinely
   reflective), broaden the angles before concluding nothing is
   there. Productive angles to try when the literal topic comes
   back empty:
     - a person, relationship, or place the topic touches
     - a feeling or mood the topic would carry
     - an adjacent topic or generalisation (asked about one
       conversation with a friend -> try the friendship, the recent
       month, the underlying tension)
     - a recurring concern the user has voiced
   Three to five attempts is usually right. In EXPLICIT mode,
   paraphrase what the user asked. Each result carries the full
   entry body plus topics / mood / people facets - read them to
   judge relevance.
2. Cross-check against the conversation. EXPLICIT: do not filter
   (the user asked, surface it). IMPLICIT: drop entries the
   conversation already restates word-for-word; keep entries that
   add detail, mood, or calibration even if loosely connected.
3. Assimilate the remaining signal into a short first-person note
   in the main assistant's voice ("I remember the user worked
   through this in April - the entries from that week carried...",
   "we have been here before; the user landed on..."). Blend
   DETAILS and CALIBRATION when both have signal: one short
   sentence each. When the signal is light but real, emit it - a
   one-line calibration is a useful note.

Reply with JSON in one of exactly these two shapes:

- \`{"kind": "none", "reason": "<short diagnostic>"}\` only after you
  have broadened your queries past the literal topic (when the
  topic is reflective) and still come up empty - or every entry
  duplicates the conversation word-for-word - or the topic is
  clearly operational and the journal has no business here. The
  \`reason\` is REQUIRED and is for diagnostics - keep it short and
  concrete and name the angles you tried ("operational topic,
  journal has no signal", "searched topic X, person Y, mood Z; no
  entry matched", "found N entries but all duplicated in-thread
  context word-for-word"). Vague reasons defeat the purpose, and
  so does giving up after one round of near-synonym queries on a
  reflective topic.

- \`{"kind": "note", "note": "<short first-person paragraph>"}\` with
  the assimilated recall. Keep \`note\` under ~400 characters - one
  tight paragraph, not a bulleted list.

Do not emit any other keys. Do not wrap the JSON in prose or a code
fence.`;

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
