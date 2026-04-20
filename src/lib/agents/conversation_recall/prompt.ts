/**
 * The conversation-recall agent's user-turn instruction. Sibling of
 * `agents/recall/prompt.ts` for memories — same "switch modes" idiom:
 * appended as the final user turn of a messages array whose prefix is
 * the live conversation trimmed to the last user turn. The model
 * reads the prior assistant turns as itself, then takes on a
 * different job — finding relevant PRIOR conversations instead of
 * replying.
 *
 * Framing notes that differ from memory recall:
 *
 *   - The search target is conversations, not memories. Facts the
 *     user shared in this thread are probably already in the memory
 *     store (via reflection); what recall is for here is something
 *     more specific — "we had a long conversation about X three
 *     months ago; here's what we landed on" — that no single memory
 *     captures but the thread summary does.
 *
 *   - Optional topic hint. When the main assistant calls
 *     `conversation_recall({topic: "moving to Lisbon"})`, the topic
 *     string is appended to the prompt so the agent biases its first
 *     `conversation_search` query toward it. Absent, the agent has
 *     to infer from the conversation above.
 *
 *   - First-person voice, same as memory recall. The main model reads
 *     the note as its own thought; third-person or quotation framing
 *     ("we discussed X") fights that pattern. "I remember we decided
 *     X last time we talked about this."
 *
 *   - Empty signal is the safe default. A note that just says "we
 *     talked about this before" without adding detail wastes tokens;
 *     better to emit `{kind:"none"}` and let the main model proceed.
 */
const BASE_PROMPT = [
  "You've just read the conversation above. Step out of the role of the",
  "main assistant \u2014 this time, you're not replying to the user. Your job",
  'is to pull relevant context from prior conversations the user has had',
  'with you. The goal is to surface detail the main model would benefit',
  "from knowing but doesn't already have in this thread.",
  '',
  'Workflow:',
  '',
  '1. Use `conversation_search` \u2014 usually more than once, with',
  '   different queries \u2014 to find past threads topically related to',
  '   where this conversation is heading. Cast a wide net; paraphrase',
  '   the user on the query string. Each result carries a 2\u20133 sentence',
  '   summary; read those to judge relevance.',
  '2. Cross-check against what this conversation has already',
  '   established. If a prior thread just repeats a fact already',
  '   in-context, drop it.',
  '3. Assimilate the remaining signal into a short first-person note',
  "   to your own future self, in the main assistant's voice (\"I",
  "   remember we decided\u2026\", \"last time this came up, we\u2026\"). Don't",
  '   attribute to a third party; this is a note you are writing to',
  '   yourself.',
  '',
  'Be conservative. A note that merely says "we talked about this',
  'before" without adding concrete detail is worse than emitting the',
  "empty signal \u2014 the main model will read any note you produce and",
  'trust it, so spurious recall actively pollutes future turns. When',
  'in doubt, emit the empty signal.',
  '',
  'Reply with JSON in one of exactly these two shapes:',
  '',
  '- `{"kind": "none"}` when you found nothing worth surfacing that',
  '  isn\'t already understood from the conversation above.',
  '- `{"kind": "note", "note": "<short first-person paragraph>"}` with',
  '  the assimilated recall. Keep `note` under ~400 characters \u2014 one',
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
 * common case — the agent reads the conversation above and makes its
 * own judgment.
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
