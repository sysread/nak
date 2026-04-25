/**
 * Prompt for the journaling agent (Journal feature). Appended as
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
 *   - **No skip branch.** The agent always calls `journal_upsert`.
 *     Earlier versions had a strict "skip if not reflective" rule and
 *     two include/exclude lists; in practice the model erred far on
 *     the side of skipping, every cycle ended `wrote=false`, and the
 *     user got an empty journal. The journal is meant as a daily
 *     record of the user's life, not just their feelings. Technical
 *     conversations get a brief log-style entry ("User worked on the
 *     auth flow today; refactored the JWT handler, decided to keep
 *     refresh-token rotation manual"); reflective conversations get
 *     the longer narrative form. The framing differs but every cycle
 *     produces a row.
 *
 *   - "Single upsert" discipline is a load-bearing invariant: the
 *     agent is told to call `journal_upsert` at most once per run.
 *     Multiple upsert calls against the same (user, date,
 *     source='automatic') key would each overwrite the previous one
 *     inside a single run, wasting round-trips with no benefit.
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
    "read this text reply. Your job is to update the user's JOURNAL",
    '(their daily diary) by calling the `journal_upsert` tool.',
    '',
    `Today's date, in the user's local timezone, is **${args.entryDate}**.`,
    `This conversation's thread id is **${args.threadId}** - include it in`,
    '`source_thread_ids` on your upsert call.',
    '',
    '## Always write something',
    '',
    'Every conversation gets an entry. The journal is a daily record of',
    "what the user did and felt - a diary, not just an emotions log.",
    'Pick the framing that fits the conversation:',
    '',
    '- **Reflective content** (feelings, interpersonal dynamics, conflict,',
    '  identity / neurodivergence processing, personal growth, venting',
    '  about life with emotional weight): lead with that. Third-person',
    "  observational, 2-6 short paragraphs. Capture the arc, not just a",
    "  list of facts. This is the long-form mode.",
    '',
    '- **Technical / transactional content** (debugging, code reviews,',
    '  recipe lookups, factual Q&A, configuration help, planning a',
    '  project): a brief log entry. One paragraph or a short bullet',
    '  list. Name what was worked on, decisions made, anything notable',
    '  to look back on. "User spent the afternoon debugging the auth',
    '  flow with the assistant; refactored the JWT handler and decided',
    '  to keep refresh-token rotation manual" is a perfectly good entry.',
    '  This is the short-form mode.',
    '',
    '- **Mixed content** (a technical conversation that drifted into',
    "  frustration, or a venting session that landed on a concrete",
    '  decision): combine. Lead with whichever was the larger arc, then',
    '  fold in the other.',
    '',
    'Do NOT skip. An empty journal is worse than a brief one - the user',
    "wants to be able to look back at any day and see what they were",
    'doing.',
    '',
    '## Voice',
    '',
    'Write in third person, observational ("User was frustrated by X",',
    '"User worked on Y", "User noticed that Z made them anxious"). The',
    "user can write their own first-person entry alongside yours; keep",
    'the two voices distinguishable. Format in Markdown - paragraphs,',
    'lists, short headers if helpful. Keep it tight: this is a daily',
    "arc, not an essay.",
    '',
    '## Building on what already exists',
    '',
  ];
  if (args.existingEntry && args.existingEntry.content.length > 0) {
    lines.push(
      'An automatic entry for today already exists. Your job is to EXTEND',
      'and REFINE it, not overwrite it. Read it below, then produce an',
      'updated version that captures the full day so far - new arcs from',
      'this conversation folded into the existing narrative. If the',
      'existing entry got something wrong (say the user reframed a',
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
    '- For purely technical conversations, `mood` may be omitted.',
    '',
    'When done, reply with a single word. The word is discarded.'
  );
  return lines.join('\n');
}
