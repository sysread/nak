/**
 * Prompt for the journaling agent (Journal feature). Appended as
 * the final user-role turn after the full conversation history. The
 * model sees itself as the prior assistant and reads this as a
 * "switch modes now" instruction.
 *
 * Selectivity. The journal is for the user's inner life - feelings,
 * relationships, processing, growth - not a daily activity log.
 * Substantive technical work is excluded by design even when the
 * user spent hours on it: a summary of "user debugged the auth
 * flow with three decisions" duplicates the chat history without
 * adding anything the user can't already recover. The bar is
 * "did the conversation move the user emotionally / relationally
 * / identity-wise", not "did anything happen". Earlier the prompt
 * leaned toward worthy=true to make the wrote-pipeline easier to
 * debug while we were chasing the SQL ambiguity bug; now that the
 * pipeline is healthy, the prompt enforces the original strict
 * filter.
 *
 * Output shape: pinned via `response_format: {type: 'json_object'}`
 * on the streamChat call, then re-asserted in this prompt as a
 * worked example. The agent does NOT call any tool - the worker
 * parses the JSON the model returns and writes the entry directly
 * via `supabase.upsertJournalAutomaticEntry` when `worthy=true`.
 *
 * Why structured output instead of a `journal_upsert` tool call:
 *
 *   - Tool-call arguments are JSON-encoded inside an outer JSON
 *     stream from the provider, so a long Markdown body has to be
 *     escaped twice. Models routinely lose track of the second
 *     escape on multi-paragraph content with embedded quotes / code
 *     fences / list markers, which surfaced as silent
 *     `wrote=true, 0 successful tool calls` runs (the local
 *     JSON.parse on the assembled arguments string would throw,
 *     the call would count as failed, and the worker would log
 *     wrote=false even though the model had written a perfectly
 *     reasonable entry it just couldn't escape correctly).
 *
 *   - response_format=json_object lets the model produce one layer
 *     of JSON, which is the failure mode it's actually trained on.
 *     Markdown content nests as a string field and Python-grade
 *     escape disasters drop to near-zero.
 *
 *   - The decide-vs-skip judgement is always wanted in the log
 *     either way; carrying it in a sibling field of the same JSON
 *     object means a single parse picks up both the decision AND
 *     (when applicable) the entry, with no second round-trip to
 *     fetch a separate "explanation" string.
 *
 * Voice: third-person observational ("User worked on X", "User was
 * frustrated by Y"). The user can write their own first-person
 * entry alongside the automatic one; the two voices stay
 * distinguishable in the daily view.
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
 * appends as a user-role message. Pair with
 * `response_format: {type: 'json_object'}` on the streamChat call so
 * the model is constrained to return JSON.
 */
export function buildJournalPrompt(args: BuildPromptArgs): string {
  const lines: string[] = [
    "You've just read the conversation above. Step out of that role.",
    "You're not the assistant talking to the user anymore. Your job is",
    'to decide whether this conversation merits an entry in the',
    "user's JOURNAL (their daily diary), and - only if it does - write",
    'one. Most conversations do not. The journal is for the inner',
    'life, not a transcript log; see "How to decide" below.',
    '',
    `Today's date in the user's local timezone is **${args.entryDate}**.`,
    'Use it as the entry_date.',
    '',
    '## Output format',
    '',
    'Return one JSON object. No prose around it, no markdown fences,',
    'no comments. Two top-level keys are always required:',
    '',
    '- `worthy` (boolean): does this conversation merit a journal',
    '  entry? See "How to decide" below.',
    '- `reasoning` (string): one sentence, plain text, naming the',
    '  concrete reason. Examples: "User vented about a recurring',
    '  conflict with their manager and reframed it as a boundary',
    '  problem." / "User worked through a difficult therapy session',
    '  about family patterns." / "Thread was a factual lookup about',
    '  the gluten content of teff with no emotional content." /',
    '  "Conversation was technical debugging - work, not journal',
    '  material."',
    '',
    'When `worthy` is true, also include:',
    '',
    '- `entry` (object): the entry to upsert. Required field',
    '  `content` (string, Markdown body, max 16000 chars). Optional',
    '  fields `topics` (string[]), `mood` (string), `people`',
    '  (string[]). Omit any optional you do not need; do not pass',
    '  empty strings or empty arrays as filler.',
    '',
    'When `worthy` is false, omit `entry` entirely (or pass null).',
    '',
    'Worked example, worthy:',
    '',
    '```',
    '{"worthy": true,',
    ' "reasoning": "User processed a difficult therapy session about',
    ' family-of-origin patterns and landed on a concrete intention.",',
    ' "entry": {',
    '   "content": "User came in tired but worked through a difficult',
    ' session on family patterns. The arc landed on naming the',
    ' boundary they want to set with their mother before the holiday',
    ' visit. By the end of the conversation they sounded settled.",',
    '   "topics": ["therapy", "family"],',
    '   "mood": "settled",',
    '   "people": ["mom"]',
    ' }}',
    '```',
    '',
    'Worked example, not worthy (factual lookup):',
    '',
    '```',
    '{"worthy": false,',
    ' "reasoning": "User asked about the gluten content of teff. No',
    ' emotional content, no reflection, no relational material - just',
    ' a definition lookup."}',
    '```',
    '',
    'Worked example, not worthy (substantive technical work):',
    '',
    '```',
    '{"worthy": false,',
    ' "reasoning": "Long debugging session on the auth flow with three',
    ' concrete decisions. The user was task-focused throughout; no',
    ' emotional weight, no identity material. Belongs in the chat',
    ' history, not the journal."}',
    '```',
    '',
    '## How to decide',
    '',
    'The Journal is for the inner life: what the user felt, processed,',
    'reframed, related-to-someone, or worked through emotionally. The',
    "bar is whether the conversation moved THE USER, not whether",
    'anything happened in it. A two-hour debugging session with three',
    'concrete decisions does NOT belong in the journal if the user',
    'never invested emotionally in the problem - it would just produce',
    "a summary of what the assistant did, which the user can recover",
    "from the chat history any time.",
    '',
    'Worthy (worthy=true) - the conversation carried at least one of:',
    '- Feelings, emotional states, self-reflection',
    '- Interpersonal dynamics, conflict, relationship processing',
    '- Venting about life situations with emotional weight',
    '- Processing neurodivergence experiences (ADHD, autism, other)',
    '- Personal growth, identity, self-perception themes',
    '- A transactional topic that drifted into emotional territory',
    '  ("the project I hate" qualifies; "how do I configure X"',
    '  does not, even if the user spent an hour on the configuration)',
    '',
    'Not worthy (worthy=false) - the default for anything that does',
    "NOT clearly fit one of the buckets above. Examples:",
    '- Factual Q&A, definitions, lookups ("what does X stand for",',
    '  "what is the gluten content of teff")',
    '- Recipe or cooking discussion (unless it drifted personal)',
    '- How-to questions, configuration help, code review, debugging,',
    '  planning - even when substantive, even when decisions got made.',
    '  These are work, not journal material, regardless of length.',
    '- Tool-driven workflows where the model did the work and the',
    "  user wasn't invested.",
    '- Trivial smalltalk ("hi", "how are you", "goodbye").',
    '',
    'When in doubt, set worthy=false. Padding the journal with',
    "summaries of dictionary lookups, recipe questions, or technical",
    'work is strictly worse than a clean skip - the user can find the',
    'conversation in the chat history if they want it; the journal is',
    "for what they couldn't.",
    '',
    '## Voice (when worthy)',
    '',
    'Third person, observational. "User was frustrated by X", "User',
    'noticed that Y made them anxious", "User reframed Z as a boundary',
    'problem". Markdown is fine - paragraphs, lists, short headers if',
    'helpful. Keep it tight; this is a daily arc, not an essay. 2-6',
    'short paragraphs is the right shape. Capture the arc, not just a',
    'list of facts.',
    '',
    '## Building on what already exists',
    '',
  ];
  if (args.existingEntry && args.existingEntry.content.length > 0) {
    lines.push(
      "An automatic entry for today already exists. Apply the worthy",
      "test to THIS conversation only. If this conversation isn't",
      'worthy, return worthy=false and the existing entry stays as is',
      '- do not rewrite or merge in technical / factual material just',
      'because there\'s already a row to extend. If this conversation',
      'IS worthy, EXTEND and REFINE the existing entry - do not start',
      'from scratch. If the existing entry got something wrong (the',
      'user reframed a feeling mid-day, say) correct it; otherwise',
      "preserve what's there and fold this conversation's new arcs",
      'into the existing narrative.',
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
      'Pass the UNIONED topics and people (existing + anything new this',
      'conversation added) and the mood that best captures the full day.',
      '`content` should be the consolidated narrative covering everything,',
      'not a diff.',
      ''
    );
  } else {
    lines.push(
      'No automatic entry exists for today yet - your `content`, when',
      'worthy=true, creates it.',
      ''
    );
  }
  lines.push(
    'Reply with the JSON object only. No surrounding prose, no markdown',
    'fence.'
  );
  return lines.join('\n');
}
