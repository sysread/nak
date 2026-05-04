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
 * on the completion call, then re-asserted in this prompt as a
 * worked example. The agent does NOT call function tools - cross-
 * context lookups happen via the context-recall pipeline at the
 * worker level, not via mid-call function rounds; see
 * `agent.ts:resolveContextRecallMessage`. The entry is emitted as
 * the structured JSON in the model's final text. The worker parses
 * that JSON and writes the entry through
 * `supabase.upsertJournalEntryAndMarkThread` when `worthy=true` - no
 * tool call ever carries the entry's Markdown body.
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

/**
 * Profile fields the user supplied in Settings -> AI -> About you.
 * Both fields are optional and may be null / empty independently.
 * When at least one is non-empty the prompt builders inject a short
 * "About the user" block so the agent can refer to the user by name
 * (rather than the generic "User") and ground location-specific
 * references precisely. When both are empty, the block is omitted -
 * a fresh account that hasn't filled the form pays zero tokens for
 * it. Mirrors the chat-loop's `buildUserProfileNote` shape so the
 * voice stays consistent across surfaces.
 */
export interface JournalUserProfile {
  name: string | null;
  location: string | null;
}

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
  /**
   * Pre-rendered, natural-language hint from the per-user spam
   * filter (see ../journal/spam_filter.ts:renderSpamHint). Null when
   * the model is in cold-start (insufficient training data per
   * class) or when scoring failed - the caller is expected to
   * suppress the section by passing null rather than asking the
   * prompt to interpret a noisy score. The hint is positioned as a
   * SOFT signal in the prompt, after the worthy/not-worthy rules,
   * so the LLM treats the conversation's actual content as primary
   * and the prior as a tiebreaker rather than a gate.
   */
  spamHint: string | null;
  /**
   * Name + location the user supplied in Settings. Null (or both
   * fields empty) suppresses the "About the user" block entirely.
   */
  userProfile: JournalUserProfile | null;
}

/**
 * Args for the regenerate prompt - the user-initiated "rewrite this
 * entry" path. Differs from BuildPromptArgs in two ways: there's
 * always an existing entry (the one being regenerated), and there's
 * no spam-filter hint or worthy/not-worthy decision because the user
 * has already opted in by clicking the button. The model is told to
 * produce a fresh take rather than extending the prior version.
 */
export interface BuildRegeneratePromptArgs {
  entryDate: string;
  /**
   * The entry the user is currently looking at and asked to
   * regenerate. Shown to the model as "this is what you wrote last
   * time; the user wants something different" rather than as a base
   * to extend, so the regenerated entry isn't just a rephrase.
   */
  existingEntry: {
    content: string;
    topics: readonly string[];
    mood: string | null;
    people: readonly string[];
  };
  /**
   * Same shape as BuildPromptArgs.userProfile. Null suppresses the
   * "About the user" block.
   */
  userProfile: JournalUserProfile | null;
}

/**
 * Render the "About the user" block injected near the top of both
 * journal prompts when the user has filled at least one of the
 * Settings -> About you fields. Returns null when both are empty so
 * callers can drop the section entirely (zero tokens for a fresh
 * account). The block tells the model to prefer the user's name
 * over the generic "User" the voice section's worked examples lean
 * on - which is the user-visible bug this fixes - and to ground
 * location-specific references precisely without reciting the
 * location as filler.
 */
function renderUserProfileBlock(
  profile: JournalUserProfile | null
): string | null {
  if (profile === null) return null;
  const name = (profile.name ?? '').trim();
  const location = (profile.location ?? '').trim();
  if (name.length === 0 && location.length === 0) return null;
  const lines: string[] = ['## About the user', ''];
  if (name.length > 0) lines.push(`Name: ${name}`);
  if (location.length > 0) lines.push(`Location: ${location}`);
  lines.push(
    '',
    'The user supplied this in Settings so the journal can refer to',
    'them naturally rather than as the generic "user".'
  );
  if (name.length > 0) {
    lines.push(
      '',
      `Prefer their name over "User" in the entry: "${name} came in`,
      `tired" reads more like a diary entry than "User came in tired".`
    );
  }
  if (location.length > 0) {
    lines.push(
      '',
      'Use the location only when it grounds something specific in',
      "the conversation (local time, weather, regional context); don't",
      'recite it back as filler.'
    );
  }
  return lines.join('\n');
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
    `This conversation started on **${args.entryDate}** (the user's`,
    'local-timezone calendar day). Use that as the entry_date - the',
    'entry belongs to the day the conversation happened on, NOT the',
    'day you are processing it on.',
    '',
  ];
  const profileBlock = renderUserProfileBlock(args.userProfile);
  if (profileBlock !== null) {
    lines.push(profileBlock, '');
  }
  lines.push(
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
    ''
  );
  if (args.spamHint !== null && args.spamHint.length > 0) {
    lines.push(
      '## Prior signal',
      '',
      args.spamHint,
      '',
      'This is a SOFT hint built from past ham/spam labels on the',
      "user's own deleted and approved entries. Treat the conversation",
      "above as primary evidence; let the prior nudge a borderline",
      'judgment but not override a clear read. A conversation that',
      'starts technical and pivots into emotional territory should',
      'still be journaled even if the early tokens read as "spam"',
      'to the prior - the worthy test is on the conversation as a',
      'whole, not its opening turns.',
      ''
    );
  }
  lines.push(
    '## Voice and focus',
    '',
    'Third person, observational. "User was frustrated by X", "User',
    'noticed that Y made them anxious", "User reframed Z as a boundary',
    'problem". Markdown is fine - paragraphs, lists, short headers if',
    'helpful. Keep it tight; this is a daily arc, not an essay. 2-6',
    'short paragraphs is the right shape.',
    '',
    "The SUBJECT of the entry is the user's inner life as the",
    'conversation revealed it: orientations, practices they\'ve built,',
    'reframings, moments of self-recognition, how they relate to',
    "themselves and others, what they're trying to work out. The",
    "conversation's topical content is EVIDENCE for that inner life,",
    'not the subject. A research thread about an ancient civilization',
    'that turned into the user articulating a daily perspective-',
    'anchoring practice should produce an entry about the practice -',
    'why they reach for that anchor, what it does for them, what they',
    'just realised about it - not an entry about the civilization. A',
    'tangent into a related concrete detail (a recipe, a piece of',
    'history) is another instance of the same inner movement, not a',
    'separate topic to summarise.',
    '',
    'Failure mode to avoid: "meeting minutes" entries that paraphrase',
    'what was discussed, who said what, and what was concluded. Those',
    "duplicate the chat history and add nothing - the user can read",
    'the conversation back any time. The journal is for what they',
    "couldn't recover from the transcript: the inner movement.",
    '',
    'Two quick tests before you finalise the entry:',
    '- SWAP THE TOPIC. If you replaced the conversation\'s subject',
    '  with a different one (Sumer -> bookbinding -> long-distance',
    '  running) and your entry still tracked the same inner arc,',
    "  you're focused on the right thing. If swapping the topic",
    "  empties the entry of meaning, you've written meeting minutes.",
    '- SWAP THE USER. If a different person could have discussed the',
    "  same topic in the same way and your entry would read the same,",
    "  you've written about the topic, not about the user.",
    '',
    'Concrete things to surface when present in the conversation:',
    '- Practices and orientations the user named or revealed ("X is',
    '  how they ground themselves")',
    "- Reframings and small revelations (\"realised Y wasn't about",
    '  what they thought it was about")',
    "- The stance or mood the conversation left them in",
    "- How a topic functions for them - what role it plays in their",
    "  life - rather than what the topic is",
    '',
    'Capture the arc the conversation traced through the USER, not',
    'the arc of the conversation itself.',
    '',
    '## Adjacent context (when present)',
    '',
    'A prior `<think>` block above this prompt may contain a short',
    'first-person recollection stitched from the user\'s saved',
    'memories and prior conversations - things the current thread',
    "implicitly references but didn't restate. When that block is",
    'present, treat it as your own background knowledge and weave',
    'relevant bits into the entry naturally; do not name the',
    'mechanism ("according to memories...") - that breaks the',
    'observational voice. When the block is absent or empty, the',
    'conversation in front of you stands on its own; do not invent',
    'cross-context that you can\'t see.',
    '',
    '## Building on what already exists',
    ''
  );
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

/**
 * Construct the prompt for a user-initiated regenerate. The user
 * clicked the regenerate button on an existing automatic entry, so
 * the worthy/not-worthy gate is bypassed and the spam-filter prior
 * is suppressed - the user has explicitly asked for an entry. The
 * existing entry is shown as "what you produced last time, the
 * user wasn't satisfied" rather than as a base to extend, so the
 * model takes a fresh angle (different framing, voice, or
 * structure) instead of returning a near-duplicate.
 *
 * The output shape is the same as {@link buildJournalPrompt} so
 * {@link parseJournalDecision} can be reused on the parse side.
 * `worthy` is forced to true here - any worthy=false response is
 * treated as a regenerate failure by the caller.
 */
export function buildJournalRegeneratePrompt(
  args: BuildRegeneratePromptArgs
): string {
  const lines: string[] = [
    "You've just read the conversation above. Step out of that role.",
    "You're not the assistant talking to the user anymore. Your job",
    "is to write a fresh JOURNAL ENTRY (third-person diary entry)",
    "for this conversation. The user previously asked the journaler",
    "to write one for this conversation, but didn't like the result -",
    "they've clicked Regenerate and want a different take.",
    '',
    `This conversation started on **${args.entryDate}** (the user's`,
    'local-timezone calendar day). Use that as the entry_date - the',
    'entry belongs to the day the conversation happened on, NOT the',
    'day you are processing it on.',
    '',
  ];
  const regenProfileBlock = renderUserProfileBlock(args.userProfile);
  if (regenProfileBlock !== null) {
    lines.push(regenProfileBlock, '');
  }
  lines.push(
    '## Output format',
    '',
    'Return one JSON object. No prose around it, no markdown fences,',
    'no comments. Required keys:',
    '',
    '- `worthy` (boolean): always true on this path - the user has',
    '  explicitly asked for an entry by clicking Regenerate.',
    '- `reasoning` (string): one sentence, plain text, naming the',
    '  angle you took (e.g. "Reframed the conversation around the',
    '  user\'s shifting relationship with their workload" or',
    '  "Tightened the original entry into the single arc that',
    '  actually moved the user").',
    '- `entry` (object): the regenerated entry. Required field',
    '  `content` (string, Markdown body, max 16000 chars). Optional',
    '  fields `topics` (string[]), `mood` (string), `people`',
    '  (string[]). Omit any optional you do not need; do not pass',
    '  empty strings or empty arrays as filler.',
    '',
    'Worked example:',
    '',
    '```',
    '{"worthy": true,',
    ' "reasoning": "Recentered the entry on the boundary the user',
    ' arrived at, rather than the work conflict that opened the',
    ' conversation.",',
    ' "entry": {',
    '   "content": "User came in venting about a coworker but the',
    ' arc that mattered was naming the boundary they want to set...",',
    '   "topics": ["work", "boundaries"],',
    '   "mood": "resolved",',
    '   "people": ["Alex"]',
    ' }}',
    '```',
    '',
    '## Voice and focus',
    '',
    'Third person, observational. "User was frustrated by X", "User',
    'noticed that Y made them anxious", "User reframed Z as a',
    'boundary problem". Markdown is fine - paragraphs, lists, short',
    'headers if helpful. Keep it tight; this is a daily arc, not an',
    'essay. 2-6 short paragraphs is the right shape.',
    '',
    "The SUBJECT of the entry is the user's inner life as the",
    'conversation revealed it - orientations, practices, reframings,',
    'self-recognitions, how they relate to themselves and others. The',
    "conversation's topical content is evidence, not the subject. A",
    "tangent into a concrete detail (a recipe, a piece of history) is",
    'another instance of the same inner movement, not a separate',
    'topic to summarise.',
    '',
    'Failure mode to avoid (and the most likely reason the user hit',
    'Regenerate): "meeting minutes" entries that paraphrase what was',
    'discussed and what was concluded, instead of naming the inner',
    'movement the conversation traced through the user. Two tests:',
    "swap the topic for an unrelated one - if your entry's arc still",
    'reads, focus is right; if swapping empties the entry, focus is',
    "wrong. Swap the user for someone else discussing the same topic -",
    'if the entry would read the same, you\'re writing about the topic,',
    'not the user.',
    '',
    '## Adjacent context (when present)',
    '',
    'A prior `<think>` block above this prompt may contain a short',
    'first-person recollection stitched from the user\'s saved',
    'memories and prior conversations. When present, weave relevant',
    'bits into the entry naturally without naming the mechanism. The',
    'user is asking for a different angle on THIS conversation, not',
    'for an essay that pulls in everything tangentially related.',
    '',
    '## How to differ from the previous entry',
    '',
    "The user clicked Regenerate because the previous entry didn't",
    'land for them. Produce something different - not just a',
    "reworded version. Concrete ways to differ: pick a different",
    'central arc (the conversation likely had several), trim what',
    'the previous entry over-emphasised, surface something the',
    'previous entry missed, or shift the structure (one continuous',
    'narrative vs. a few short beats). Match the conversation; do',
    "not invent material that isn't there.",
    '',
    '**Previous entry (the one the user wants replaced):**',
    '',
    '```markdown',
    args.existingEntry.content,
    '```',
    ''
  );
  if (args.existingEntry.topics.length > 0) {
    lines.push(`Previous topics: ${args.existingEntry.topics.join(', ')}`);
  }
  if (args.existingEntry.mood) {
    lines.push(`Previous mood: ${args.existingEntry.mood}`);
  }
  if (args.existingEntry.people.length > 0) {
    lines.push(
      `Previous people: ${args.existingEntry.people.join(', ')}`
    );
  }
  lines.push(
    '',
    'Topics, mood, and people on the new entry should reflect the',
    'angle YOU take - they need not match the previous entry. Keep',
    'whatever still fits, drop what your fresh take leaves behind,',
    'and add what your angle introduces.',
    '',
    'Reply with the JSON object only. No surrounding prose, no',
    'markdown fence.'
  );
  return lines.join('\n');
}
