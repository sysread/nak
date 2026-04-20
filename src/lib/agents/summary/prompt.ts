/**
 * The summary agent's user-turn instruction. Appended as the final
 * message to a messages array whose prefix IS the original
 * conversation — the model sees itself as the prior assistant, same
 * framing as the reflection agent, for the same reason: the
 * third-party-transcript angle dilutes signal, while the first-person
 * angle keeps the writing focused on what the thread was actually
 * about.
 *
 * Format:
 *   - 2–3 sentences. Not a bulleted list — we're producing text that
 *     will be concatenated with the title and embedded by
 *     bge-m3, and bge-m3 handles prose more gracefully than
 *     whitespace-heavy formats. Each sentence adds ~20–40 tokens of
 *     semantic context beyond what the title already carries.
 *   - Topical, not conversational. "Debugging a race condition in the
 *     chat scroll handler on mobile Safari" beats "The user asked
 *     about a scroll bug and the assistant suggested a few fixes."
 *     The first describes the thread's subject; the second describes
 *     the thread's shape, which every thread shares.
 *   - Present tense. Biases the language toward subject matter rather
 *     than narrative. Small effect, but consistent.
 *   - No hedging, no preamble, no filler. "Here's a summary:" / "This
 *     conversation covers" start every summary with tokens that
 *     contribute nothing. The explicit instruction is what stops the
 *     model from producing them.
 *
 * Discarding: the only consumer is the embeddings worker, which
 * concatenates `title + summary` as the input string. The row is
 * human-readable in Supabase but never surfaced in the UI — the
 * drawer shows the title, and search shows the title. Keep that in
 * mind if you're tempted to tune the prompt for a particular prose
 * style; the audience is bge-m3, not a reader.
 */
export const SUMMARY_PROMPT = [
  "You've just finished the conversation above. Step out of that role.",
  "Nobody will read this reply as a chat turn — it's being used as a",
  'search index for this conversation.',
  '',
  'Write a 2–3 sentence topical summary of what this conversation is',
  'about. Describe the subject matter — the problem, the domain, the',
  'artifacts discussed — not the shape of the exchange. Present tense.',
  'No preamble, no trailing pleasantries, no hedging, no bullet list.',
  'Just the summary.',
].join('\n');
