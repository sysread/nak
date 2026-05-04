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
 *   - "Not already present" is the whole game for the FACTS half. A
 *     recall note that parrots facts already in-conversation wastes
 *     tokens and teaches the main model that recall is low-signal.
 *     The prompt leans hard on this: search, then cross-check against
 *     the transcript above before deciding to emit.
 *
 *   - The CALIBRATION half is the second drive: surface what the user
 *     already knows about the topic so the main model can pitch its
 *     answer at the right depth without re-explaining what the user
 *     mastered last week. This is calibration, not curation - we are
 *     NOT bending facts to user preference (that's the sycophancy
 *     trap), we're telling the main model "the user is past the
 *     intro on X, skip the basics." Calibration only earns its place
 *     in the note when it would change how the main model frames the
 *     answer; do not list interests for their own sake.
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
  'is to recall relevant context that would help answer the latest turn.',
  'There are two distinct things worth surfacing, and the bar is',
  'different for each:',
  '',
  '  (1) FACTS the main model needs but does not already have in this',
  '      thread. Standing memories about the user, prior decisions,',
  '      preferences, constraints. The bar here is HIGH: only emit a',
  '      fact that is materially relevant to the latest turn AND is',
  "      not already established in the conversation above. A fact",
  '      already in-thread is worse than no note at all.',
  '',
  '  (2) CALIBRATION about what the user already knows about this',
  '      topic. Background, expertise, things they have worked through',
  '      before. The bar here is "would it change how the main model',
  '      pitches the answer?" - if the user is deep in this material,',
  '      the main model should not re-explain the basics; if they are',
  '      newly arriving at it, the main model should not assume',
  '      jargon. Do NOT list interests for their own sake; only emit',
  '      calibration that would change the level/depth of the answer.',
  '',
  'Workflow:',
  '',
  '1. Use `memory_search` — usually more than once, with different',
  '   queries — to find memories that could be relevant to where the',
  '   conversation is heading. Cast a wide net; paraphrase the user on',
  "   the search query.",
  '2. Cross-check every candidate against what the conversation has',
  '   already established. For FACTS: drop anything already in-thread.',
  '   For CALIBRATION: drop anything that would not change how the',
  '   main model frames its answer.',
  '3. Assimilate what is left into a short paragraph — your own',
  "   first-person note to yourself, in the main assistant's voice",
  "  (\"I remember that…\", \"I know from before that the user has",
  "  already worked through…\"). Don't attribute the memory to anyone",
  '   else; this is a note you are writing to your own future self.',
  '   When you have both kinds of signal, blend them in one paragraph -',
  '   one short sentence on facts, one short sentence on calibration -',
  '   in the same first-person voice.',
  '',
  'Each memory carries a `confidence_tag` (corroborated / hedged /',
  'shaky / null) and a `relations` list pointing at linked memories.',
  'Use both when deciding what to include: a [shaky] fact should be',
  'hedged in your note ("I have a hazy sense that..."), a [corroborated]',
  'one should be stated more confidently, and a relation that points at',
  'a directly-relevant linked memory is often a better pick than the',
  'hit itself.',
  '',
  'Be conservative on facts. A note that parrots the conversation is',
  'worse than no note at all — the main model will read it and trust',
  'it, so spurious recall actively pollutes future turns. When the',
  'fact channel is empty AND the calibration channel is empty, emit',
  'the empty signal.',
  '',
  'Reply with JSON in one of exactly these two shapes:',
  '',
  '- `{"kind": "none"}` when neither channel has anything worth',
  "  injecting that isn't already understood from the conversation",
  '  above.',
  '- `{"kind": "note", "note": "<short first-person paragraph>"}` with',
  '  the assimilated recall. Keep `note` under ~400 characters — one',
  '  tight paragraph, not a bulleted list.',
  '',
  'Do not emit any other keys. Do not wrap the JSON in prose or a code',
  'fence.',
].join('\n');
