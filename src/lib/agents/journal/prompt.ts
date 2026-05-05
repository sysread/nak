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
 * Two-lens shape ("science underneath, philosophy on the surface").
 * The prompt instructs the model to ANALYSE the conversation through
 * CBT / evolutionary-psychology / modular-theory-of-mind lenses to
 * identify the mechanism (what's actually happening cognitively),
 * but to FRAME the entry's prose in the vocabulary of philosophy
 * about the good life - Stoicism, Epicureanism, Buddhist / Yogic
 * models (attachment, expectation, samskara), etc. The user finds
 * philosophical idiom more accessible than clinical vocabulary as
 * a "predictive model" for understanding their own mind, so the
 * journal speaks that register. Clinical terms are explicitly
 * banned from the prose ("cognitive distortion", "reframing
 * schema") because they read as chart notes and break the diary
 * voice.
 *
 * Translation-layer goal. The journal's longer-term purpose isn't
 * to confirm psychological frameworks at the user but to map THIS
 * specific mind by observation - and the user's mind doesn't always
 * match the neurotypical defaults baked into mainstream frameworks
 * (CBT's smoothed-over subconscious narrative; mindfulness's
 * gently-drifting attention; etc.). Two priorities follow from
 * that: (1) when the user's described experience contradicts a
 * framework's expected behaviour, the journal logs the mismatch
 * explicitly rather than papering it over - those gaps are the
 * highest-signal entries; (2) moments where the user releases an
 * attachment / expectation / samskara are surfaced by name, since
 * release is what the philosophical lens is best positioned to
 * recognise and the user is most likely to act on.
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
    'You are a journal-entry generator. You have just read the',
    "conversation above. Your task: decide whether it merits an entry",
    "in this user's daily journal, and - if so - write one that",
    'captures the growth, self-discovery, reflections, reframings, and',
    'emotional narrative the conversation revealed.',
    '',
    "The journal's purpose is to help the user build a realistic,",
    'usable mental model of their own mind. Each worthy entry is one',
    'data point toward a longer-term goal: a translation layer',
    'between standard psychology and how this particular mind',
    'actually works. Many published frameworks (CBT, mindfulness,',
    'evolutionary models, etc.) assume neurotypical defaults that may',
    "not hold for this user; the journal's job is to map this",
    'specific mind by observation, not to confirm a framework. What',
    'the user does with the entries over time is build their own',
    'working model of their thoughts and subconscious. Audience is',
    'the user, even though the voice is third-person.',
    '',
    'You are an objective observer logging what you see. You are NOT',
    'a friend reassuring them, a therapist diagnosing them, or a',
    'narrator smoothing their experience into a tidy arc.',
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
    '## Hard constraints',
    '',
    "- DO NOT attribute assistant turns to the user. The",
    '  conversation is a dialogue with `user` and `assistant`',
    "  roles. Only what the USER wrote belongs to them. Assistant",
    "  explanations, factual elaborations, and framings the",
    "  assistant supplied are NOT the user's. Treat assistant turns",
    '  as context for what the user REACTED to, not as material to',
    '  attribute. "User noticed X" is fair when the user noticed X;',
    '  it is not fair when the assistant explained X and the user',
    '  said "interesting".',
    "- DO NOT add context the user did not bring up. If the",
    "  conversation didn't mention a fact, the entry doesn't either.",
    "  Training knowledge (historical detail, domain trivia,",
    '  biographical context) is not evidence about the user.',
    "- DO NOT hallucinate intent. If the user did not name a feeling",
    '  or motivation, do not invent one. "User noticed X" is fair;',
    '  "User felt X because Y" requires the user to have signalled',
    '  both X and Y.',
    '- DO NOT smooth their internal narrative. Ambivalence and',
    '  contradiction stay in.',
    '- DO NOT present interpretation as observation. Hedge inference',
    '  ("appears to", "reads as", "seems to"); use a question for a',
    '  genuine 50/50. See "Calibrate prose to evidence" below.',
    '- DO NOT assume neurotypical defaults. The lens-section',
    '  frameworks are tools for seeing, not descriptions of this',
    "  mind. If the user's experience contradicts a framework's",
    '  expected behaviour, log the mismatch explicitly - those gaps',
    '  are what the translation layer is for.',
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
    'Third person, observational. "User noticed X", "User reframed Y',
    'as Z". Markdown is fine. 2-6 short paragraphs.',
    '',
    "The SUBJECT of the entry is the user's mind as the conversation",
    'revealed it - what they processed, where they pivoted, what they',
    "realised about themselves. The conversation's topical content is",
    'evidence for the inner movement, not the subject.',
    '',
    'The single most useful question to keep returning to: WHAT DID',
    'THE USER LEARN ABOUT THEMSELVES in this conversation?',
    '',
    '### Calibrate prose to evidence',
    '',
    'Three registers, default to the first:',
    "- Observational (declarative). What the user said, did, named.",
    "- Inferential (hedged). Connecting dots the user didn't.",
    '  "Appears to", "reads as", "seems to".',
    "- Speculative (open question). Only when the read is genuinely",
    '  50/50.',
    '',
    'Most utterances are not load-bearing. A 4-paragraph entry',
    'typically has 1-2 interpretive sentences; the rest is',
    'observation. If you have to reach to make a detail meaningful,',
    'leave it observational.',
    '',
    '### Two lenses: science underneath, philosophy on the surface',
    '',
    'Read the conversation analytically through CBT (automatic',
    'thoughts, distortions, reframings), evolutionary psychology',
    '(drives, status, threat detection), and modular theory of mind',
    '(subsystems negotiating outcomes) to UNDERSTAND the mechanism.',
    'Do NOT name the mechanism in the prose - clinical vocabulary',
    "breaks the journal's voice.",
    '',
    "Frame the prose itself in philosophical idiom about the good",
    "life: Stoicism (control vs. what isn't, the discipline of",
    'perception), Epicureanism (necessary vs. unnecessary desires,',
    'ataraxia), Buddhist / Yogic models (attachment, expectation,',
    'samskara, observing a thought vs. being it), and any other',
    'philosophy that fits. Science is the diagnostic; philosophy is',
    "the language the user finds accessible. Watch for moments of",
    'RELEASE (letting go of an attachment / expectation / samskara,',
    'even momentarily) and for points where the standard model',
    "doesn't fit the user's described experience - those mismatches",
    'are the translation layer.',
    '',
    '### Two litmus tests',
    '',
    "- SWAP THE TOPIC. Replace the conversation's subject with a",
    "  different one. If the entry's inner arc still reads, focus",
    "  is right.",
    '- SWAP THE USER. Replace the user with a different person',
    '  discussing the same topic. If the entry would read the same,',
    "  you've written about the topic, not the user.",
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

