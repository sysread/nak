/**
 * The recall agent's user-turn instruction. Appended as the final
 * message in a messages array whose prefix IS the live conversation,
 * ending at the last user turn. The model reads the prior assistant
 * turns as itself — same framing the reflection agent uses — then
 * switches modes: its job is to pull in relevant memories the
 * conversation doesn't already surface, not to answer the user.
 *
 * Framing:
 *
 *   - The output is consumed by another model (the main-thread chat
 *     model), not rendered to the user. We tell the agent that
 *     explicitly so it doesn't adopt conversational tone or apologise
 *     when nothing is worth noting — a terse empty signal is better
 *     than a paragraph of "I couldn't find anything."
 *
 *   - "Not already present" is the whole game. A recall note that
 *     parrots facts already in-conversation wastes tokens and teaches
 *     the main model that recall is low-signal. The prompt leans hard
 *     on this: search, then cross-check against the transcript above
 *     before deciding to emit.
 *
 *   - First-person voice. The main model receives the note as a tool
 *     result and treats it as its own thought. Third-person or
 *     quotation framing ("the user once said X") reads as external
 *     input and fights that pattern. "I remember…" / "I know from
 *     before that…" is what we want.
 *
 *   - The response_format (json_object, see RecallAgent) constrains
 *     the shape; the prompt spells out the shape too because some
 *     providers honour json_object as "any valid JSON" rather than a
 *     specific schema. Belt-and-suspenders.
 */
export const RECALL_PROMPT = [
  "You've just read the conversation above. Step out of the role of the",
  "main assistant — this time, you're not replying to the user. Your job",
  'is to recall relevant memories that would help answer the latest turn,',
  'but only memories that are NOT already present in the conversation.',
  '',
  'Workflow:',
  '',
  '1. Use `memory_search` — usually more than once, with different',
  '   queries — to find memories that could be relevant to where the',
  '   conversation is heading. Cast a wide net; paraphrase the user on',
  "   the search query.",
  '2. Cross-check every candidate memory against what the conversation',
  '   has already established. If the fact (or a close paraphrase)',
  '   is already in-thread, drop it.',
  '3. Assimilate what is left into a short paragraph — your own',
  "   first-person note to yourself, in the main assistant's voice",
  "   (\"I remember that…\", \"I've learned before that…\"). Don't",
  '   attribute the memory to anyone else; this is a note you are',
  '   writing to your own future self.',
  '',
  'Be conservative. A note that parrots the conversation is worse than',
  'no note at all — the main model will read it and trust it, so',
  'spurious recall actively pollutes future turns. When in doubt, emit',
  'the empty signal.',
  '',
  'Reply with JSON in one of exactly these two shapes:',
  '',
  '- `{"kind": "none"}` when you found nothing relevant that isn\'t',
  '  already understood from the conversation above.',
  '- `{"kind": "note", "note": "<short first-person paragraph>"}` with',
  '  the assimilated recall. Keep `note` under ~400 characters — one',
  '  tight paragraph, not a bulleted list.',
  '',
  'Do not emit any other keys. Do not wrap the JSON in prose or a code',
  'fence.',
].join('\n');
