/**
 * Fast-model prompts for the samskara formation pipeline.
 *
 * Each phase of the worker drives one of these prompts via a single
 * Venice streamChat call (no tool loop, no multi-round). Output is
 * always a JSON object the worker parses; the prompt names the
 * required fields explicitly so the model's structured-output
 * behaviour is consistent across providers.
 *
 * Prompts are kept short on purpose: the fast model has limited
 * context-window budget vs the smart tier and we'd rather pay tokens
 * for inputs than for instructions. The intent of each phase lives in
 * the docs/dev/samskara.md design doc; this file just teaches the
 * model the local task.
 */

/**
 * Assimilator prompt. Reads one user/assistant exchange and returns
 * the structured substrate fields. The model never sees the eventual
 * samskara use of this output — it just describes what happened.
 */
export const ASSIMILATOR_PROMPT = [
  'You are summarising one round of a conversation between a user and',
  'an AI assistant. Read the user message and the assistant response,',
  'then describe what happened in a way another AI could later cluster',
  'with similar rounds.',
  '',
  'Reply with a single JSON object, no prose, no markdown fence:',
  '',
  '{',
  '  "situation": "third-person observation of what the user asked and the surrounding context",',
  '  "outcome": "what the assistant did and how the situation appeared to land",',
  '  "valence": <number from -1.0 to 1.0 capturing emotional charge: negative for tense / frustrated / corrective, positive for warm / satisfied / curious, 0 for neutral>',
  '}',
  '',
  'Keep `situation` under 240 chars. Keep `outcome` under 240 chars.',
  'Be concrete: name what was asked, the topic, any constraints the',
  'user mentioned. Do not editorialise about the user or the assistant.',
  'Do not include a name or pronoun for the assistant - "the assistant"',
  'is fine.',
].join('\n');

/**
 * Relator prompt. Reads two substrate situations and labels the
 * relation between them, or returns kind='orthogonal' if there isn't
 * one worth recording. The worker discards orthogonal verdicts.
 */
export const RELATOR_PROMPT = [
  'You are comparing two snapshots of past conversations. Each snapshot',
  'has a `situation` and an `outcome`. Decide whether there is a',
  'meaningful relation between them.',
  '',
  'Reply with a single JSON object, no prose, no markdown fence:',
  '',
  '{',
  '  "kind": "pattern" | "contrast" | "prerequisite" | "consequence" | "orthogonal",',
  '  "label": "short phrase, <= 12 words, capturing the relation"',
  '}',
  '',
  'Kinds:',
  '- "pattern": both snapshots show a similar tendency (same mood, same',
  '  approach, same kind of ask).',
  '- "contrast": one is a clear inverse of the other.',
  '- "prerequisite": A leads naturally to B.',
  '- "consequence": B is a downstream effect of an A-like situation.',
  '- "orthogonal": no meaningful relation. When you pick this, set',
  '  `label` to an empty string.',
  '',
  'Bias toward orthogonal when in doubt. A relation worth recording',
  'should suggest something predictive about the user.',
].join('\n');

/**
 * Minter prompt. Reads a cluster of related substrate or association
 * snippets and produces a samskara - a one-line predictive claim
 * about the user. Returns confirm:false to refuse weak clusters.
 */
export const MINTER_PROMPT = [
  'You are minting a "samskara" - a short, predictive claim about a',
  'user, derived from a cluster of past observations. The samskara',
  'should be the kind of thing a future you could read at the start',
  'of a conversation and act on instinctively.',
  '',
  'Reply with a single JSON object, no prose, no markdown fence:',
  '',
  '{',
  '  "confirm": true | false,',
  '  "prediction": "one or two sentences in the form: in situations like X, this user tends to Y",',
  '  "inner_voice": "optional silent self-talk, <= 80 chars, like an internal post-it note. Empty string if not useful.",',
  '  "valence": <-1.0 to 1.0, the emotional flavour of the tendency>,',
  '  "confidence": <0.0 to 1.0, your initial confidence in the claim>',
  '}',
  '',
  'Set confirm:false when:',
  '- the cluster is too noisy to support a single prediction,',
  '- the prediction would be obvious or vapid,',
  '- you would need to invent details to make it specific.',
  '',
  'When you set confirm:false, you may leave the other fields as',
  'empty strings or zeros - they will be discarded.',
  '',
  'When you set confirm:true, the prediction should be specific to the',
  'user. "User asks about coding" is too vague. "User pushes back on',
  'flowery responses to terse technical questions" is the right shape.',
].join('\n');

/**
 * Reaction-classifier prompt. Reads a cohort of samskaras that fired
 * on the previous turn plus the user's response to that turn, and
 * partitions the cohort into confirm / disconfirm / neutral buckets.
 */
export const REACTION_PROMPT = [
  'You are scoring how a user reacted to an AI assistant turn that was',
  'shaped by a set of "samskaras" - predictive claims about the user.',
  '',
  'You will receive:',
  '- the cohort that shaped the previous turn, as an array of {id, prediction},',
  '- the assistant message that was sent,',
  '- the user message that came next.',
  '',
  'For each samskara in the cohort, decide whether the new user',
  'message confirms the prediction (the user behaved as the samskara',
  'expected), disconfirms it (the user did the opposite), or is',
  'neutral (the user message was about something unrelated, or did',
  'not speak to the prediction either way).',
  '',
  'Reply with a single JSON object, no prose, no markdown fence:',
  '',
  '{',
  '  "confirm": [<id>, ...],',
  '  "disconfirm": [<id>, ...],',
  '  "neutral": [<id>, ...]',
  '}',
  '',
  'Every id from the cohort must appear in exactly one bucket. Bias',
  'toward neutral when the signal is ambiguous - false confidence in',
  'either direction skews future priming more than missing a real',
  'signal.',
].join('\n');

/**
 * Compound-summary prompt. Reads the top live samskaras and produces',
 * a prose paragraph the chat loop appends to every system prompt as',
 * the always-on calibration block.
 */
export const COMPOUND_SUMMARY_PROMPT = [
  'You will receive a list of samskaras - short predictive claims a',
  'previous AI assistant has formed about a user across many',
  'conversations. Each carries a `prediction`, an optional',
  '`inner_voice`, a `valence` in [-1, 1], a `confidence` in [0, 1],',
  'and a `health` in [0, 1]. Stronger samskaras (high health *',
  'confidence) are listed first.',
  '',
  'Compose a single prose paragraph (4-8 sentences) that reads as the',
  '"current best model of who this user is and how to engage with',
  'them." The paragraph will be appended to a future assistant\'s',
  'system prompt as always-on context, so write in the third person',
  'about the user (not in the second person addressing them).',
  '',
  'Lean into the signal from the strongest samskaras; let weaker ones',
  'colour the paragraph rather than name themselves. Where samskaras',
  'tension or contradict each other, surface the tension rather than',
  'collapsing it. Do not enumerate or list. Do not mention the word',
  '"samskara". Do not include numbers or bullet points.',
  '',
  'Reply with the paragraph only - no headings, no JSON, no prose',
  'about your task.',
].join('\n');
