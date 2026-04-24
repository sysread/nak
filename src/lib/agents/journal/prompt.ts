/**
 * Prompt for the journaling agent (Reflections feature). Appended as
 * the final user-role turn after the full conversation history, same
 * framing as the memory-extraction prompt in `../reflection/prompt.ts`:
 * the model sees itself as the prior assistant and reads this as a
 * "switch modes now" instruction.
 *
 * Design notes:
 *
 *   - Fills the role of a third-person observational journaler, not
 *     first-person. User-authored entries are first-person ("I was
 *     anxious about the review"); the automatic entry is written
 *     about the user ("User was anxious about the review"). This
 *     keeps the two voices distinguishable in the daily view.
 *
 *   - The prompt includes today's existing automatic entry (if any)
 *     as context and instructs the agent to extend/refine it rather
 *     than overwrite. This is the "continue from where you left off"
 *     behavior the user asked for: the worker may re-run on the same
 *     conversation across the day as new turns accrue, and each run
 *     should build on what's already been captured rather than
 *     re-summarising from scratch.
 *
 *   - Include / exclude lists come straight from the feature spec
 *     (feelings, interpersonal dynamics, self-reflection,
 *     neurodivergence processing; NOT pure tech Q&A, recipe lookups
 *     unless they drift personal, etc.). The model needs explicit
 *     rules because "what counts as reflective" is the kind of
 *     judgement call that otherwise produces drift across runs.
 *
 *   - "Single upsert" discipline is a load-bearing invariant: the
 *     agent is told to call `journal_upsert` at most once per run.
 *     Multiple upsert calls against the same (user, date,
 *     source='automatic') key would each overwrite the previous one
 *     inside a single run, wasting round-trips with no benefit.
 *
 *   - "Skip this turn" is an explicit branch: if the conversation
 *     doesn't carry any reflective content, the agent should produce
 *     no tool call. The thread still gets marked as journaled (the
 *     pointer advances) so the worker doesn't reconsider the same
 *     messages next cycle.
 */

export interface BuildPromptArgs {
  entryDate: string;
  /** Existing automatic entry for this day, or null if first run. */
  existingEntry: {
    content: string;
    topics: readonly string[];
    mood: string | null;
    people: readonly string[];
  } | null;
  threadId: string;
}

/**
 * Construct the final-turn prompt. Returns a single string the caller
 * appends as a user-role message.
 */
export function buildJournalPrompt(args: BuildPromptArgs): string {
  const lines: string[] = [
    "You've just read the conversation above. Step out of that role.",
    "You're not the assistant talking to the user anymore - nobody will",
    'read this text reply. Your job is to update the user\'s REFLECTIONS',
    "(their daily journal) by calling the `journal_upsert` tool.",
    '',
    `Today's date, in the user's local timezone, is **${args.entryDate}**.`,
    `This conversation's thread id is **${args.threadId}** - include it in`,
    '`source_thread_ids` on your upsert call.',
    '',
    '## What goes in a Reflections entry',
    '',
    'INCLUDE content that is reflective in nature:',
    '- Feelings, emotional states, self-reflection',
    '- Interpersonal dynamics, conflicts, relationship processing',
    '- Venting about work/life situations with emotional weight',
    '- Processing neurodivergence experiences (ADHD, autism, other)',
    '- Personal growth, identity, self-perception themes',
    '- Any transactional topic that drifted into emotional territory',
    '  ("My boss is making me work on a project I hate" qualifies;',
    '   "How do I configure X?" does not)',
    '',
    'EXCLUDE content that is not reflective:',
    '- Purely technical or transactional exchanges',
    '- Recipe or cooking discussion (unless it drifted personal)',
    '- Factual Q&A, lookups, how-tos',
    '- Tool-driven workflows with no emotional dimension',
    '',
    'If the conversation above contains NOTHING reflective, DO NOT call',
    'any tool. Reply with a single word and stop. The worker will mark',
    'the thread journaled and move on. Fabricating reflective content',
    'where none exists is strictly worse than skipping.',
    '',
    '## Voice',
    '',
    'Write in third person, observational ("User was frustrated by X",',
    '"User noticed that Y made them anxious"). The user can write their',
    'own first-person entry alongside yours; keep the two voices',
    'distinguishable. Format in Markdown - paragraphs, lists, short',
    'headers if helpful. Keep it tight: this is a daily arc, not an',
    'essay. A good entry is 2-6 short paragraphs.',
    '',
    '## Building on what already exists',
    '',
  ];
  if (args.existingEntry && args.existingEntry.content.length > 0) {
    lines.push(
      "An automatic entry for today already exists. Your job is to EXTEND",
      'and REFINE it, not overwrite it. Read it below, then produce an',
      'updated version that captures the full day so far - new emotional',
      'arcs from this conversation folded into the existing narrative. If',
      "the existing entry got something wrong (say the user reframed a",
      'feeling mid-day), correct it; otherwise preserve what\'s there.',
      '',
      '**Existing automatic entry:**',
      '',
      '```markdown',
      args.existingEntry.content,
      '```',
      ''
    );
    if (args.existingEntry.topics.length > 0) {
      lines.push(`Existing topics: ${args.existingEntry.topics.join(', ')}`);
    }
    if (args.existingEntry.mood) {
      lines.push(`Existing mood: ${args.existingEntry.mood}`);
    }
    if (args.existingEntry.people.length > 0) {
      lines.push(`People already mentioned: ${args.existingEntry.people.join(', ')}`);
    }
    lines.push('');
    lines.push(
      'When you call `journal_upsert`, pass the UNIONED topics and people',
      '(existing + anything new this conversation added) and the mood that',
      'best captures the full day. `content` should be the consolidated',
      'narrative covering everything, not a diff.',
      ''
    );
  } else {
    lines.push(
      'No automatic entry exists for today yet - your upsert creates it.',
      ''
    );
  }
  lines.push(
    '## Mechanics',
    '',
    '- Call `journal_upsert` AT MOST ONCE. Multiple upserts in one run',
    '  overwrite each other and waste tokens.',
    '- Required fields: `entry_date`, `content`. Pass the values above.',
    '- Optional: `topics`, `mood`, `people`, `source_thread_ids`.',
    '- If the conversation has nothing reflective, skip the tool call',
    '  entirely and reply with a single word.',
    '',
    'When done, reply with a single word. The word is discarded.'
  );
  return lines.join('\n');
}
