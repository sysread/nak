/**
 * The recall agent's user-turn instruction. Appended as the final
 * message in a messages array whose prefix IS the live conversation,
 * ending at the last user turn. The model reads the prior assistant
 * turns as itself - same framing the reflection agent uses - then
 * switches modes: its job is to pull in relevant memories the
 * conversation doesn't already surface, not to answer the user.
 *
 * Why two modes (EXPLICIT vs IMPLICIT):
 *
 *   `memory_recall` is the only memory-read tool that's always-on,
 *   so the main model reaches for it both when it's preparing context
 *   for an unrelated question (implicit) AND when the user has
 *   directly asked what nak remembers about them (explicit). Earlier
 *   versions of this prompt only had the implicit shape - "is this
 *   memory materially relevant to the latest turn AND not already in-
 *   thread?" - and the explicit case kept emitting empty because the
 *   user's "what do you remember about me?" was being parsed as an
 *   open question with no specific topic to be relevant to.
 *
 *   The mode distinction lowers the bar in EXPLICIT: when the user
 *   asked, the relevance check is the question itself. Don't filter.
 *   IMPLICIT keeps the strict bar so spurious recall doesn't pollute
 *   the main model's context for routine turns.
 *
 * Why an empty-signal `reason` field:
 *
 *   The model emits `{kind:"none", reason:"..."}` when there's
 *   nothing worth injecting, with a short diagnostic explanation.
 *   The reason rides into the tool result so:
 *   (a) the main model sees what was tried and can decide whether
 *       to retry with a different angle or proceed without recall,
 *   (b) the log drawer surfaces it for the developer/user to
 *       distinguish "search returned nothing" from "candidates were
 *       too noisy" from "user is in a topic recall has nothing for."
 *   Without the reason, a "memory_recall keeps emitting empty"
 *   diagnostic loop has no observable signal.
 *
 * Other framing (preserved from the original):
 *
 *   - The output is consumed by another model, not rendered to the
 *     user. Terse JSON, no apologies, no preamble.
 *
 *   - First-person voice ("I remember...", "I know from before
 *     that...") so the main model treats the note as its own thought.
 *     Third-person framing ("the user once said X") reads as
 *     external input.
 *
 *   - The response_format (json_object) constrains the shape; the
 *     prompt spells the schema out too because some providers honour
 *     json_object as "any valid JSON" rather than a specific schema.
 */
export const RECALL_PROMPT = [
  "You've just read the conversation above. Step out of the role of the",
  "main assistant - this time, you're not replying to the user. Your job",
  'is to recall memory context that helps the main model answer the',
  'latest turn.',
  '',
  'First, decide which mode you are in by reading the latest user turn:',
  '',
  '  EXPLICIT recall: the user asked the main model directly what it',
  '  remembers, what it knows about them, what their preferences are,',
  '  what they told you about X, and similar meta-questions about',
  '  memory itself. The user wants memories surfaced. Bar is LOW: the',
  '  relevance test IS the question, so do not also filter on',
  '  "materially relevant to the latest turn." Surface what you find.',
  '',
  '  IMPLICIT recall: the user asked a regular question and the main',
  '  model called recall hoping to find context that would help answer',
  '  it. Bar is HIGH: only emit memories that are materially relevant',
  '  to the latest turn AND not already established in the conversation',
  '  above. A note that parrots in-thread context wastes tokens and',
  '  trains the main model to trust low-signal recall.',
  '',
  'Two channels worth surfacing in either mode:',
  '',
  '  (1) FACTS the main model would benefit from: standing memories',
  '      about the user, prior decisions, preferences, constraints. In',
  '      EXPLICIT mode, surface any facts that match the question. In',
  '      IMPLICIT mode, only facts materially relevant to the latest',
  '      turn AND not already in-thread.',
  '',
  '  (2) CALIBRATION about what the user already knows about the topic.',
  '      "Would it change how the main model pitches the answer?" - if',
  '      the user is deep in this material, the main model should not',
  '      re-explain the basics; if newly arriving, it should not',
  '      assume jargon. Do NOT list interests for their own sake; only',
  '      emit calibration that would change level/depth.',
  '',
  'Workflow:',
  '',
  '1. Pick the mode (above), then use `memory_search` - usually more',
  '   than once, with different queries - to find candidates. In',
  '   EXPLICIT mode, broad queries are fine ("about the user",',
  '   "preferences", whatever the user asked about). In IMPLICIT mode,',
  "   paraphrase the user's actual topic and search for that.",
  '2. Cross-check candidates against the conversation. EXPLICIT: do',
  '   not filter (the user asked, surface it). IMPLICIT: drop facts',
  '   already in-thread; drop calibration that would not change level.',
  '3. Assimilate what is left into a short first-person paragraph in',
  "   the main assistant's voice (\"I remember that...\", \"I know from",
  '   before that...") - your own note to your future self, NOT a',
  '   third-person quotation. Blend FACTS and CALIBRATION when both',
  '   have signal: one short sentence each.',
  '',
  'Each memory carries a `confidence_tag` (corroborated / hedged /',
  'shaky / null) and a `relations` list pointing at linked memories.',
  'Use both: a [shaky] fact should be hedged in your note ("I have a',
  'hazy sense that..."), a [corroborated] one stated more confidently,',
  'and a relation pointing at a directly-relevant linked memory is',
  'often a better pick than the hit itself.',
  '',
  'Reply with JSON in one of exactly these two shapes:',
  '',
  '- `{"kind": "none", "reason": "<short diagnostic>"}` when nothing is',
  '  worth injecting. The `reason` is REQUIRED and is for diagnostics',
  '  - keep it short and concrete ("no memories matched any query I',
  '  tried", "all candidates were already in-thread", "search returned',
  '  N hits but none materially relevant", "the user asked about X and',
  '  no stored memory mentions X"). Vague reasons defeat the purpose.',
  '',
  '- `{"kind": "note", "note": "<short first-person paragraph>"}` with',
  '  the assimilated recall. Keep `note` under ~400 characters - one',
  '  tight paragraph, not a bulleted list.',
  '',
  'Do not emit any other keys. Do not wrap the JSON in prose or a code',
  'fence.',
].join('\n');
