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
    "- DO NOT hallucinate intent. If the user did not name a feeling",
    '  or a motivation, do not invent one. "User noticed X" is fair;',
    '  "User felt X because Y" requires that the user actually',
    '  signalled both X and Y in the conversation.',
    '- DO NOT smooth their internal narrative. If they were',
    '  ambivalent, contradictory, or unresolved, the entry preserves',
    "  that. The mind being modelled is the messy real one, not a",
    '  cleaned-up version.',
    '- DO NOT put words in their mouth. The voice (third-person',
    '  observation) is yours; the substance - what they said, what',
    '  they meant by it, what they were processing - is theirs.',
    '- DO NOT assume neurotypical defaults. The frameworks named',
    '  in the lens section are tools for seeing, not authoritative',
    "  descriptions of this user's mind. If their described",
    "  experience contradicts a framework's expected behaviour",
    '  (e.g. the smoothed-over subconscious narrative meditation',
    "  assumes; the automatic emotional labelling CBT relies on),",
    '  the mismatch is itself the data point worth logging - flag',
    "  it explicitly. Those gaps are exactly what the translation",
    '  layer is for.',
    '- DO NOT present interpretation as observation. Hedge inference',
    '  ("appears to", "reads as", "seems to"); use a question for a',
    '  genuine 50/50. See "Calibrate prose to evidence" below.',
    "- DO NOT add context the user did not bring up. If the",
    "  conversation didn't mention a fact, the entry doesn't",
    '  either. Knowledge from your training (historical detail,',
    '  domain trivia, biographical context the user did not',
    "  supply) is not evidence about the user - importing it",
    "  fabricates substance the journal can't ground in what",
    'actually happened in the conversation.',
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
    'as Z", "User landed on...". Markdown is fine - paragraphs, lists,',
    'short headers if helpful. Keep it tight; this is a daily arc, not',
    'an essay. 2-6 short paragraphs.',
    '',
    "The SUBJECT of the entry is the user's mind as the conversation",
    'revealed it: what they processed, where they pivoted, what they',
    'realised about themselves, the shape of the cognitive and',
    "emotional machinery in motion. The conversation's topical content",
    'is EVIDENCE for the inner movement, not the subject.',
    '',
    'The single most useful question to keep returning to: WHAT DID',
    'THE USER LEARN ABOUT THEMSELVES in this conversation? Most worthy',
    'entries answer that even when the user did not phrase it as an',
    'explicit realisation. Look also for:',
    '- Practices and orientations the user named or revealed ("X is',
    '  how they ground themselves")',
    '- Reframings, pivots, and small revelations - and the assistant',
    "  prompt or question that catalysed them, when there was one",
    "- MOMENTS OF RELEASE. When the user lets go of an attachment,",
    "  expectation, or samskara - even momentarily. Name what was",
    "  held and what loosened (or what sat differently afterward);",
    "  the release is more useful than the holding. These can be",
    '  small ("noticed the urge to refresh and didn\'t") or large',
    '  ("realised the resentment they\'d been carrying about X had',
    '  quietly stopped mattering").',
    '- WHERE THE STANDARD MODEL DOESN\'T FIT. When the user describes',
    "  something that contradicts a framework's default assumption -",
    "  about how attention works, how emotion labels itself, how the",
    "  subconscious smooths experience, how habits form. These",
    '  mismatches are the highest-value entries: they are exactly',
    '  what the translation layer is being built to record.',
    "- The stance or mood the conversation left them in",
    "- How a topic FUNCTIONS for them (the role it plays in their",
    "  life) rather than what the topic is",
    "- Patterns in how their mind processes data - what it reaches",
    "  for, what it discounts, what hooks its attention, where it",
    "  routes around the path the framework would predict",
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
    'leave it observational. Imposing meaning is a slip mode, not',
    'the goal.',
    '',
    '### Two lenses: science underneath, philosophy on the surface',
    '',
    'Read the conversation through analytical frames to UNDERSTAND',
    'what is happening cognitively:',
    '- CBT (automatic thoughts, cognitive distortions, reframings)',
    '- evolutionary psychology (drives, status, in-group / out-group,',
    '  threat detection, the costs and signals behind a behaviour)',
    '- modular theory of mind (different mental subsystems negotiating',
    '  an outcome)',
    '',
    "Use these to identify the mechanism, the loop, the leverage",
    "point. But do NOT name the mechanism in the entry's prose.",
    'Clinical vocabulary ("cognitive distortion", "reframing schema",',
    '"status threat") reads as a chart note and breaks the journal\'s',
    'voice.',
    '',
    "Frame the entry's prose itself in the vocabulary of philosophy",
    'about the good life:',
    "- Stoicism (the discipline of perception, what's in our control",
    "  vs. what isn't, premeditatio malorum)",
    '- Epicureanism (the difference between necessary, natural, and',
    '  unnecessary desires; ataraxia as a target)',
    '- the Buddhist and Yogic models of mind (attachment, expectation,',
    "  the samskaras prior responses cut into the next ones, the",
    '  difference between observing a thought and being it)',
    '- any other philosophical idiom for living well that fits the',
    '  moment',
    '',
    'The shape: science underneath, philosophy on the surface. An',
    'entry might silently identify a CBT-style reframing as the',
    'mechanism while naming it in the prose as the user "loosening',
    'an attachment" or "noticing the difference between what they',
    'control and what they don\'t" or "sitting with a samskara without',
    'acting on it". The science is the diagnostic; the philosophy is',
    'the language the user finds accessible for thinking about their',
    'own life.',
    '',
    'Both lenses are TOOLS for seeing, not authoritative descriptions.',
    "If the user's described experience contradicts a framework's",
    "expected behaviour, that mismatch is the most valuable kind of",
    'observation for the translation-layer goal. Examples of useful',
    'mismatches to flag explicitly:',
    "- The framework assumes a smoothed-over subconscious narrative",
    "  the conscious mind has to listen for, but the user describes",
    '  their experience as bare and noisy with smoothing arriving',
    '  only afterward as rationalisation.',
    "- The framework assumes attention drifts gently and can be",
    "  re-anchored, but the user describes attention as something",
    "  that snaps or stalls rather than drifts.",
    "- The framework assumes emotion arrives pre-labelled, but the",
    "  user describes feeling state as needing translation before",
    "  it's legible to them.",
    'Those gaps are exactly what the journal exists to catalogue.',
    '',
    '### Failure modes to avoid',
    '',
    '- "Meeting minutes" entries that paraphrase what was discussed',
    "  and what was concluded. The chat history exists; the journal",
    "  is for what it doesn't carry.",
    '- Therapeutic / clinical voice. The lenses inform the diagnosis,',
    '  not the prose.',
    "- Smoothing or moralising. The journal logs; it doesn't lecture",
    '  the user about their own life.',
    '- Over-framing tangents. A concrete detail (a recipe, a piece of',
    '  history, a code decision) that arose during a reflective',
    '  conversation is another instance of the same inner movement,',
    '  not a separate topic to summarise.',
    '',
    '### Two litmus tests',
    '',
    "- SWAP THE TOPIC. Replace the conversation's subject with a",
    '  different one (sourdough -> bookbinding -> long-distance',
    "  running). If the entry's inner arc still reads, focus is",
    "  right. If swapping empties the entry, you've written meeting",
    '  minutes.',
    '- SWAP THE USER. Replace the user with a different person',
    '  discussing the same topic. If the entry would read the same,',
    "  you've written about the topic, not the user.",
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

