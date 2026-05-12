/**
 * The reflection agent's user-turn instruction. Appended as the final
 * message in a messages array whose prefix IS the original
 * conversation — the model sees itself as the prior assistant, which
 * is a better angle for spotting its own misfires than reading a
 * third-party transcript.
 *
 * Format note: we use a user-role turn (not system) because a
 * trailing system message is unusual and models treat it
 * inconsistently. A user message that says "now do this instead"
 * after a long assistant response is the standard "switch modes"
 * idiom — every model we might plausibly use has seen it a thousand
 * times during fine-tuning.
 *
 * Framing:
 *
 *   - The model is told explicitly that nobody will read its text
 *     reply. The value is the side effects (memory_* calls), not the
 *     final string. This prevents "As an AI assistant, I've carefully
 *     considered…"-style filler that a normal chat turn would produce.
 *
 *   - Explicit analysis axes (user facts, personality signals,
 *     reactions, self-guidance) keep the model from settling into a
 *     single mode — without them, the reflection tends to produce
 *     only fact extractions and miss the behavioral observations that
 *     make future turns better.
 *
 *   - The "search before create" and "update over fragment" rules are
 *     the difference between a memory store that evolves and one that
 *     accretes duplicates. Without them, each reflection cycle would
 *     create a new "user prefers X" memory instead of updating the
 *     existing one.
 *
 *   - memory_invalidate (not memory_delete) is the only deletion
 *     tool in this toolbox — the agent can't hard-erase anything.
 *     Invalidation halves confidence; repeated invalidation hides the
 *     memory from search but keeps the row recoverable.
 *
 *   - "Be conservative" is load-bearing. Without it, a model eager to
 *     be seen helping will over-write — capturing every turn of
 *     phrase as a memory. Fewer, higher-signal memories are better
 *     than many noisy ones, because the memory_search boost is
 *     logarithmic (corroborated memories win, but a dense list of
 *     one-off observations still dilutes rank).
 */
export const REFLECTION_PROMPT = `You've just finished the conversation above. Now step out of that
role. You're not talking to the user anymore — nobody will read this
reply. Your job is to update long-term memory based on what
happened, using the memory tools below.

Think about:

- **Facts about the user** — name, work, tools, projects, preferences,
  constraints. Concrete, reusable information.
- **Personality signals** — how they communicate, what they value, what
  frustrates or delights them.
- **Reactions to you** — did they push back? agree? redirect? That is
  data about what works and doesn't with this person.
- **Self-guidance** — short notes to your future self, in the voice
  of a coach. "This user prefers terse answers." "Don't assume
  they want code examples without asking." "They appreciate when
  you name the tradeoff rather than defaulting to a recommendation."

Workflow for each memory you consider writing:

1. Call memory_search with a related query FIRST. Check whether a
   similar memory already exists.
2. If one exists and your new insight is a refinement, call
   memory_update on it (which also bumps confidence — corroborated
   memories rank higher). Don't create a near-duplicate.
3. If a new insight contradicts an existing memory, call
   memory_invalidate on the stale one. This doesn't delete it, it
   halves its confidence so search stops surfacing it. Repeated
   invalidation hides it entirely. Recoverable if you re-learn the
   fact later.
4. Only call memory_create when nothing close exists.

Be conservative. Fewer high-signal memories beat many low-signal
ones. Don't record the obvious ("the user asked a question"),
ephemeral details that only matter for one conversation, or
anything that reads like a summary of what was already said.

When you have nothing more to write, reply with a single word. The
word is discarded — only the tool calls matter.`;
