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
const BASE_PROMPT = `You've just read the conversation above. Step out of the role of the
main assistant - this time, you're not replying to the user. Your job
is to pull relevant context from prior conversations the user has had
with you.

First, decide which mode you are in by reading the latest user turn:

  EXPLICIT recall: the user asked the main model directly about a
  past conversation - "what was that thread we had on X?", "remind
  me what we landed on with Y", "did we talk about Z before?". The
  user wants prior threads surfaced. Bar is LOW: the relevance test
  IS the question, so do not also filter on "would it change how
  the main model frames the answer." Surface what you find with
  enough detail to answer the user.

  IMPLICIT recall: the user asked a regular question and the main
  model called recall hoping context from a prior thread would
  help. Bar is MODERATE: emit when a prior thread adds useful
  signal - the actual decision, conclusion, working-through, or
  the calibration of "we have worked on this before, here's the
  shape." Drop threads that exactly duplicate what is already
  in-thread, but do not over-filter. A partial-signal note is
  usually better than empty; the main model decides what to lean
  on. Reach for kind:none only when searches genuinely returned
  nothing OR every thread is word-for-word what the conversation
  already establishes.

Two channels worth surfacing in either mode:

  (1) DETAILS from prior threads the main model would benefit from
      knowing - the actual decision, the actual conclusion, the
      thing the user worked through that informs the current turn.
      In EXPLICIT mode, surface what answers the user. In IMPLICIT
      mode, surface details that add to the current conversation -
      either filling a gap or shaping the answer.

  (2) CALIBRATION about how deeply the user has worked through this
      topic across past threads. If they have iterated across
      several threads, the main model should not retread the basics;
      if fresh direction, it should not assume context. Surface
      calibration that helps the main model frame the answer - even
      a soft "we have circled this a few times before" beats no
      calibration at all.

Workflow:

1. Pick the mode (above), then use \`conversation_search\` - usually
   more than once, with different queries - to find candidate
   threads. IMPORTANT: do not stop after 2-3 near-synonym queries.
   If your first round comes back empty or thin, broaden the angles
   before concluding nothing is there. Productive angles to try
   when the literal topic comes back empty:
     - an adjacent topic or generalisation (asked about a specific
       gardening choice -> try the garden project, the season, the
       location)
     - a person or place that anchors the topic
     - a constraint or recurring concern the user has voiced
     - the most active recent project / thread theme
   Three to five attempts across different angles is usually right.
   In EXPLICIT mode, paraphrase what the user asked. Each search
   result carries a 2-3 sentence summary; read those to judge.
2. Cross-check against the conversation. EXPLICIT: do not filter
   (the user asked, surface it). IMPLICIT: drop threads that the
   conversation already restates word-for-word; keep threads that
   add detail, decision, or calibration even if loosely connected.
3. Assimilate the remaining signal into a short first-person note
   in the main assistant's voice ("I remember we decided...",
   "last time this came up, we...", "we have already worked
   through..."). Blend DETAILS and CALIBRATION when both have
   signal: one short sentence each. When the signal is light but
   real, emit it - a one-line calibration is a useful note.

Reply with JSON in one of exactly these two shapes:

- \`{"kind": "none", "reason": "<short diagnostic>"}\` only after you
  have broadened your queries past the literal topic and still come
  up empty - or every thread is exactly what the conversation
  already states. The \`reason\` is REQUIRED and is for diagnostics -
  keep it short and concrete and name the angles you tried
  ("searched topic X, adjacent Y, anchor person Z; no prior thread
  matched", "found N threads but all duplicated in-thread context
  word-for-word"). Vague reasons defeat the purpose, and so does
  giving up after one round of near-synonym queries.

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
