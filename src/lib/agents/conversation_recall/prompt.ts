/**
 * The conversation-recall agent's user-turn instruction. Sibling of
 * `agents/recall/prompt.ts` for memories - same "switch modes" idiom:
 * appended as the final user turn of a messages array whose prefix
 * is the live conversation trimmed to the last user turn. The model
 * reads the prior assistant turns as itself, then takes on a
 * different job - finding relevant PRIOR conversations instead of
 * replying.
 *
 * Same EXPLICIT vs IMPLICIT mode distinction the memory recall
 * prompt now uses. Without it, the model defaulted to the strict
 * "concrete detail beyond 'we talked about this'" bar even when the
 * user explicitly asked "what did we discuss before about X?" - and
 * came back empty far too often.
 *
 * Same `reason` field on the empty signal as memory recall. The
 * note rides into the tool result and feeds the log drawer +
 * tool-result panel; without it, "conversation_recall keeps emitting
 * empty" diagnostic loops have no observable signal.
 *
 * Framing notes that differ from memory recall:
 *
 *   - Search target is conversations, not memories. Facts the user
 *     shared are usually in the memory store; what conversation
 *     recall is for is "we had a long conversation about X three
 *     months ago; here's what we landed on" - something no single
 *     memory captures but the thread summary does.
 *
 *   - Optional topic hint. When the main assistant calls
 *     `conversation_recall({topic: "moving to Lisbon"})`, the topic
 *     string is appended to the prompt so the agent biases its
 *     first search query toward it. Absent, the agent infers from
 *     the conversation above.
 *
 *   - First-person voice ("I remember we decided X last time we
 *     talked about this"), same as memory recall. The main model
 *     reads the note as its own thought; third-person framing
 *     ("we discussed X") fights that pattern.
 */
const BASE_PROMPT = [
  "You've just read the conversation above. Step out of the role of the",
  "main assistant - this time, you're not replying to the user. Your job",
  'is to pull relevant context from prior conversations the user has had',
  'with you.',
  '',
  'First, decide which mode you are in by reading the latest user turn:',
  '',
  '  EXPLICIT recall: the user asked the main model directly about a',
  '  past conversation - "what was that thread we had on X?", "remind',
  '  me what we landed on with Y", "did we talk about Z before?". The',
  '  user wants prior threads surfaced. Bar is LOW: the relevance test',
  '  IS the question, so do not also filter on "would it change how',
  '  the main model frames the answer." Surface what you find with',
  '  enough detail to answer the user.',
  '',
  '  IMPLICIT recall: the user asked a regular question and the main',
  '  model called recall hoping context from a prior thread would',
  '  help. Bar is HIGH: only emit when a prior thread adds CONCRETE',
  '  DETAIL the main model would benefit from. A note that just says',
  '  "we talked about this before" without adding detail wastes',
  '  tokens and is worse than no note at all.',
  '',
  'Two channels worth surfacing in either mode:',
  '',
  '  (1) DETAILS from prior threads the main model would benefit from',
  '      knowing - the actual decision, the actual conclusion, the',
  '      thing the user worked through that informs the current turn.',
  '      In EXPLICIT mode, surface what answers the user. In IMPLICIT',
  '      mode, only emit when the detail is concrete and not already',
  '      in-thread.',
  '',
  '  (2) CALIBRATION about how deeply the user has worked through this',
  '      topic across past threads. "Would it change how the main',
  '      model pitches the answer?" - if they have iterated on this',
  '      across several threads, the main model should not retread',
  '      the basics; if fresh direction, it should not assume',
  '      context. Do NOT list past topics for their own sake.',
  '',
  'Workflow:',
  '',
  '1. Pick the mode (above), then use `conversation_search` - usually',
  '   more than once, with different queries - to find candidate',
  '   threads. In EXPLICIT mode, paraphrase what the user asked. In',
  "   IMPLICIT mode, paraphrase the user's actual topic. Each result",
  '   carries a 2-3 sentence summary; read those to judge relevance.',
  '2. Cross-check against the conversation. EXPLICIT: do not filter',
  '   (the user asked, surface it). IMPLICIT: drop threads that do',
  '   not add concrete detail beyond what is already in-thread; drop',
  '   calibration that would not change level/depth.',
  '3. Assimilate the remaining signal into a short first-person note',
  "   in the main assistant's voice (\"I remember we decided...\",",
  '   "last time this came up, we...", "we have already worked',
  '   through..."). Blend DETAILS and CALIBRATION when both have',
  '   signal: one short sentence each. Do not attribute to a third',
  '   party; this is a note you are writing to yourself.',
  '',
  'Reply with JSON in one of exactly these two shapes:',
  '',
  '- `{"kind": "none", "reason": "<short diagnostic>"}` when nothing is',
  '  worth injecting. The `reason` is REQUIRED and is for diagnostics',
  '  - keep it short and concrete ("no prior threads matched the',
  '  queries I tried", "found N threads but none added concrete',
  '  detail beyond the current conversation", "the user asked about X',
  '  and no prior thread mentions X"). Vague reasons defeat the',
  '  purpose.',
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
export function buildConversationRecallPrompt(topic?: string | null): string {
  const clean = typeof topic === 'string' ? topic.trim() : '';
  if (clean.length === 0) return BASE_PROMPT;
  return (
    BASE_PROMPT +
    '\n\n' +
    `The main assistant flagged this topic specifically: ${clean}`
  );
}

/** Plain prompt without a topic, exported for tests that need the string directly. */
export const CONVERSATION_RECALL_PROMPT = BASE_PROMPT;
