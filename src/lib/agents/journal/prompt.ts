/**
 * Prompt for the journaling agent (Journal feature). Appended as
 * the final user-role turn after the full conversation history. The
 * model sees itself as the prior assistant and reads this as a
 * "switch modes now" instruction.
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
    "to update the user's JOURNAL (their daily diary) for the day this",
    'conversation happened on, and to explain that decision in one',
    'sentence the operator can scan in a log line.',
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
    '  concrete reason. Examples: "Thread was a debugging session on',
    '  the auth refactor with two concrete decisions worth logging."',
    '  / "User vented about a recurring conflict with their manager',
    '  and reframed it as a boundary problem." / "Thread was a',
    '  one-shot factual question with no follow-up."',
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
    'Worked example, not worthy:',
    '',
    '```',
    '{"worthy": false,',
    ' "reasoning": "Conversation was a single factual lookup about',
    ' Postgres array syntax. No reflection, no decisions, nothing',
    ' worth logging."}',
    '```',
    '',
    '## How to decide',
    '',
    'The Journal is a daily record of the user\'s life - both what they',
    'thought / felt / processed AND what they actually worked on. Lean',
    'toward worthy=true. The bar is "would the user, looking back at',
    'this day in three months, want to see anything about this',
    'conversation?" - not "was this emotional?". A debugging session',
    "with concrete decisions clears the bar; a recipe lookup with no",
    'follow-up does not.',
    '',
    'Worthy (worthy=true):',
    '- Feelings, dynamics, conflict, identity / neurodivergence',
    '  processing, growth - the long-form reflective material.',
    '- Substantive technical work: debugging, code review, planning,',
    '  decisions made, things learned. Log style is fine here -',
    '  brief paragraph or short bullet list naming what was worked on.',
    '- Mixed: a technical thread that drifted into venting, or a',
    '  venting session that landed on a concrete plan. Combine.',
    '',
    'Not worthy (worthy=false):',
    '- One-shot factual Q&A with no follow-up ("what does X stand for",',
    '  "what year did Y happen") and no emotional or decision content.',
    '- Trivial back-and-forth where nothing happened ("hi, how are you",',
    '  followed by smalltalk and goodbye).',
    '- Pure tool-driven workflows where the model executed a',
    "  mechanical task and the user had no investment in it.",
    '',
    'When in doubt, lean toward worthy=true. An empty journal is worse',
    'than a brief entry. Do NOT fabricate emotional content for a',
    "technical thread; just say what the user worked on.",
    '',
    '## Voice (when worthy)',
    '',
    'Third person, observational. "User worked on X", "User noticed',
    'that Y made them anxious", "User decided to keep the manual',
    'refresh-token rotation". Markdown is fine - paragraphs, lists,',
    "short headers if helpful. Keep it tight; this is a daily arc, not",
    'an essay. Reflective entries: 2-6 short paragraphs. Technical',
    'entries: one paragraph or a short bullet list.',
    '',
    '## Building on what already exists',
    '',
  ];
  if (args.existingEntry && args.existingEntry.content.length > 0) {
    lines.push(
      "An automatic entry for today already exists. When you write the",
      'new `content`, EXTEND and REFINE it - do not start from scratch.',
      "If the existing entry got something wrong (the user reframed a",
      "feeling mid-day, say) correct it; otherwise preserve what's",
      'there and fold this conversation\'s new arcs into the existing',
      'narrative.',
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
