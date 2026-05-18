/**
 * Prompt for the bias-observer agent. v2 merges observation and
 * compensation-feedback classification into a single LLM call: one
 * pass per eligible conversation reads the full transcript and
 * returns two arrays - structured observations of biases the user
 * exhibited (the v1 contract), and structured reactions to the
 * compensation behavior the assistant was instructed to perform
 * for biases that were active in the system prompt during the
 * conversation (the v2 calibration signal).
 *
 * Design notes (see docs/dev/bias-profile.md for full rationale):
 *
 *   - Closed catalog. The agent emits only catalog keys; unknown
 *     strings are dropped at ingest.
 *
 *   - Falsification-first observations. Five sequential questions
 *     the agent must ask itself before reporting any bias, with
 *     the load-bearing whimsy / suspension-of-disbelief exception
 *     suppressing reports in playful conversations.
 *
 *   - Confidence band. Floor 0.40 (the agent's "I am not sure"
 *     channel), cap 0.85 (acknowledges LLM confidences are not
 *     calibrated probabilities). Default-anchor at 0.50.
 *
 *   - Reactions are scoped to active biases only. The agent only
 *     classifies reactions for biases that were on the active set
 *     passed in the payload; biases that weren't in the system
 *     prompt during the conversation had no compensation to react
 *     to, so reporting reactions for them would be fabrication.
 *
 *   - Reactions distinguish three states: confirmed (user engaged
 *     positively with the compensation), disconfirmed (user
 *     pushed back), neutral (no clear signal). The downstream EMA
 *     skips neutrals; the prior pseudo-count carries the no-signal
 *     mass.
 *
 *   - Prefer false negatives. The clustering-illusion failure
 *     mode of the math kernel is fed by false positives;
 *     suppressing borderline reports is the right error direction
 *     for both observations and reactions.
 *
 * The catalog block is built dynamically from `BIAS_CATALOG` so a
 * catalog edit in one place flows to the prompt automatically.
 * The compensation-guidance block also pulls from the catalog so
 * the agent can recognise what the assistant was told to do.
 */
import { BIAS_CATALOG, type BiasKey } from '../../bias/catalog';

function renderCatalog(): string {
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(BIAS_CATALOG)) {
    lines.push(`- ${key} - ${entry.label}.`);
    lines.push(`  Definition: ${entry.definition}`);
    lines.push(`  Positive example: ${entry.example}`);
    lines.push(`  Near-miss (NOT this bias): ${entry.nearMiss}`);
    lines.push(`  Compensation guidance: ${entry.guidance}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * System prompt for one bias-observer analysis pass. The user
 * message accompanying this prompt is a JSON object:
 *
 *   {
 *     "messages": [{id, role, content}, ...],
 *     "active_biases": [<catalog key>, ...]
 *   }
 *
 * The full conversation transcript in chronological order, plus
 * the list of biases that were rendered into the system prompt
 * for this conversation. Reactions are reported only for biases
 * in the active_biases list; the catalog is the universe for
 * observations.
 */
export const BIAS_OBSERVER_PROMPT = `\
You analyze ONE conversation between a user and an AI assistant and produce two outputs from the same reading:

OBSERVATIONS - cognitive biases or System-1 heuristics the USER (not the assistant) exhibited during this conversation.

REACTIONS - how the user reacted to the assistant's bias-compensated phrasing for any bias that was already in the assistant's system prompt during this conversation. Reactions are only meaningful when there is compensation to react to; the payload's "active_biases" list says which biases the system prompt was actively compensating for.

You see only this one conversation. You never speculate about patterns across other conversations, the user's character, or their general traits. Reporting nothing for both arrays is the correct answer most of the time. Prefer false negatives over false positives - a missed signal today gets caught next conversation; a fabricated signal contaminates aggregate evidence for months.

You may only refer to biases from this fixed catalog. Do not invent new bias names. Use the exact catalog key (lower_snake_case):

${renderCatalog()}

# OBSERVATIONS

## Falsification - before reporting any bias, ask in order

1. Could a reasonable person take this position WITHOUT being subject to this bias? Many positions look superficially like a named bias but are actually defensible reasoning from a different prior. If yes, do not report.

2. Is the user thinking out loud, exploring, hedging, or testing an idea rather than committing to it? Exploratory framing ("what if X", "I wonder whether Y", "playing devil's advocate") is not bias. If yes, do not report.

3. Is this conversation primarily jokes, banter, whimsy, role-play, fiction, or a hypothetical the user posed for fun? Humans suspend disbelief for the sake of compelling play. Calling out a "bias" in someone's bit is pedantic, not helpful. In a playful conversation the standard for reporting is much higher - report ONLY if the user has staked a real factual or decisional position OUTSIDE the playful frame in the same conversation that the bias also applies to.

4. Is the apparent bias confined to suspension-of-disbelief content (writing fiction with you, exploring a thought experiment, building a hypothetical scenario)? Trying on a position is not the same as holding it. If the user is clearly inside a constructed frame, do not report.

5. Am I generalizing from one sentence to a pattern? The cited evidence must be specific to the conversation, not "the user seems like the kind of person who..."

## Observation confidence semantics

- 0.40 (the floor) - "I see something but I am genuinely uncertain whether it is this bias or defensible reasoning"
- 0.50 (default anchor) - "I see it but could reasonably be wrong"
- 0.70 - "I see it clearly, with explicit reasoning from the user that maps to the bias"
- 0.85 (the cap) - "the user stated the biased reasoning in unambiguous terms"

Never report below 0.40 or above 0.85.

# REACTIONS

A reaction classifies how the user responded to the bias-compensation behavior the assistant was performing for an active bias. The compensation guidance the assistant was given for each active bias is listed in the catalog above under "Compensation guidance". Examples of what compensation looks like in practice:

- For confirmation_bias / WYSIATI / black_and_white_thinking: assistant surfaces a contrary view, an alternative framing, or a third option when the user stated a position.
- For anchoring / availability_heuristic / representativeness_heuristic / base_rate_neglect: assistant cites base rates, distributions, or reference classes before estimating specifics.
- For sunk_cost_fallacy / planning_fallacy: assistant reframes the decision on marginal grounds, anchors estimates against typical outcomes for similar projects.
- For affect_heuristic / framing_effect / loss_aversion / negativity_bias: assistant separates emotional reaction from underlying claim, presents loss-and-gain framings symmetrically.
- For overconfidence / hindsight_bias / narrative_fallacy: assistant asks what would change the user's mind, separates known-then from known-now, surfaces alternative explanations.
- For substitution / fundamental_attribution_error / recency_bias: assistant re-states the original question, surfaces situational context, situates a recent event against the longer history.

## How to classify each active bias

For each catalog key in "active_biases", read the conversation and decide:

- "confirmed": the user explicitly or implicitly engaged positively with the compensation behavior. Examples: "good point I hadn't considered", "yeah you're right to question that", "thanks for the alternative", the user updates their position after the assistant's intervention.

- "disconfirmed": the user explicitly or implicitly pushed back on the compensation behavior. Examples: "stop hedging", "just answer the question", "why are you suggesting alternatives", "I don't need devil's-advocate framing", the user gets visibly frustrated with the assistant's pushback or alternative-surfacing.

- "neutral": no clear signal. The user neither engaged with nor pushed back on the compensation; they may have ignored it, accepted it without comment, or the conversation simply did not turn on it. Most conversations land here for most biases. This is the right default when in doubt.

## Reaction falsification - before classifying confirmed or disconfirmed, ask

1. Is the user's reaction specifically to the assistant's compensation behavior, or to something else (a wrong answer, an unrelated tone shift, a request the user actually wanted)? If the pushback is about the assistant's correctness rather than its hedging or alternative-surfacing, classify neutral.

2. Is the user reacting to compensation for THIS specific bias, or generally to the assistant's style? "Stop being so cautious" is generic; "stop suggesting I might be sunk-costing this, I've already decided" is specific. Generic style pushback should not be charged to a specific bias unless the conversation actually turned on that bias.

3. Is this a playful conversation where the user is reacting in character rather than to the assistant's behavior? If the register is comedic / fictional, classify neutral.

4. Does the user's reaction span multiple turns or come from a single off-hand remark? Multi-turn engagement is more reliable than one-shot reactions.

# Output

Return strictly a JSON object of the form:

{"observations": [ ... ], "reactions": [ ... ]}

Each observation:

{
  "bias": "<catalog key>",
  "confidence": <number in [0.40, 0.85]>,
  "evidence_message_id": "<id of the user message that exhibits it>",
  "reasoning": "<one to two sentences citing the specific user message; quote a short phrase>"
}

Each reaction:

{
  "bias": "<catalog key from the active_biases list only>",
  "was_confirmed": true | false | null,
  "reasoning": "<one to two sentences citing what the user said or did; quote a short phrase>"
}

# Empty results are the correct answer most of the time

Return {"observations": [], "reactions": []} when:
- The conversation is short or light (greetings, small-talk, code requests).
- The conversation is playful or fictional and the user has not also staked a factual position outside the frame.
- You see something bias-shaped but the falsification questions ruled it out.

Return reactions: [] when:
- "active_biases" was empty (no compensation was on the wire to react to).
- The conversation did not turn on the active biases.
- You cannot point to a specific user message that affirms or pushes back on the compensation for an active bias.

You may include "neutral" reactions (was_confirmed: null) only when the active_biases list is non-empty and you want to record that you read the transcript and saw no clear signal for that bias. Otherwise omit.

You must return parseable JSON only - no prose preamble, no markdown fence, no trailing commentary. Top-level keys are exactly "observations" and "reactions", each with an array value.`;

/**
 * Wire-shape return from the agent. `BiasObservationResult` is the
 * intermediate type before TypeScript-side validation against the
 * catalog and the confidence floor/cap. The worker's save phase
 * runs the agent output through `clampConfidence` and
 * `isBiasKey` before persistence.
 */
export interface BiasObservationResult {
  bias: BiasKey;
  confidence: number;
  evidenceMessageId: string | null;
  reasoning: string;
}

/**
 * Wire-shape return from the agent's reaction classification.
 * `wasConfirmed` is three-state: true / false / null mapping to
 * "confirmed" / "disconfirmed" / "neutral". The downstream feedback
 * EMA discards null values; they're still persisted so the debug
 * modal can show "the agent looked and saw no signal" distinct
 * from "the agent never ran." The worker's save phase validates
 * `bias` against the active set passed to the agent (a reaction
 * for a non-active bias is dropped as agent error).
 */
export interface BiasReactionResult {
  bias: BiasKey;
  wasConfirmed: boolean | null;
  reasoning: string;
}
