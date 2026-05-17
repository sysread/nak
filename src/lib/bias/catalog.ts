/**
 * The fixed catalog of cognitive biases and System-1 heuristics the
 * observer agent reports against. Closed enum on purpose: free-form
 * bias names mean the agent invents different labels for the same
 * phenomenon across conversations and no cross-conversation
 * aggregation works. Adding a catalog entry is a deliberate code
 * change, not an agent decision.
 *
 * Each entry ships four pieces:
 *
 *   - `definition`: one terse sentence the observer reads.
 *   - `example`: a clear positive case so the agent has a template.
 *   - `nearMiss`: a contrast case that LOOKS like the bias but
 *     isn't, to keep false positives down.
 *   - `guidance`: the pre-written instruction injected into the
 *     main chat LLM's system prompt when this bias clears a tier.
 *     Two short sentences max; ASCII; phrased as imperatives. No
 *     diagnostic naming - the chat LLM compensates, it doesn't
 *     announce the bias.
 *
 * The list is broadly Kahneman-aligned (Thinking, Fast and Slow)
 * plus the chat-conversation-specific items confirmation_bias,
 * sunk_cost_fallacy, recency_bias, negativity_bias, and
 * black_and_white_thinking that aren't in TFAS by name but are
 * what shows up in actual user conversations. We deliberately do
 * NOT split heuristics from their failure modes (e.g. availability
 * heuristic vs availability bias) - the worker can only see
 * observable behavior, and the underlying mechanism is the same.
 *
 * survivorship_bias is intentionally absent - it's almost never
 * observable in a single chat conversation; it requires a
 * counterfactual "the cases we don't see" that the observer can't
 * surface from a transcript.
 */

export const BIAS_CATALOG = {
  confirmation_bias: {
    label: 'Confirmation bias',
    definition:
      'Weighing evidence that supports an existing view more heavily than evidence that contradicts it.',
    example:
      'User holds a position, the assistant offers a counter-example, and the user latches onto the one part of the response that agrees with them.',
    nearMiss:
      'The user updating in the direction of new evidence is NOT confirmation bias, even if the update is partial.',
    guidance:
      'Name at least one credible contrary view when the user states a position. Do not simply elaborate on their framing.',
  },
  sunk_cost_fallacy: {
    label: 'Sunk-cost fallacy',
    definition:
      'Continuing an investment of time, money, or effort because of what has already been spent rather than future expected value.',
    example:
      'User says they should keep using an approach because they have already spent N hours on it.',
    nearMiss:
      'Continuing because the approach is genuinely working or learning from the past is NOT sunk-cost reasoning.',
    guidance:
      'Evaluate decisions on marginal grounds and future expected value. Past investment is information about the past, not a reason to continue.',
  },
  anchoring: {
    label: 'Anchoring',
    definition:
      'Letting an initial number, option, or framing pull subsequent estimates toward itself even when the anchor is arbitrary.',
    example:
      'User asks if a price is reasonable after the assistant or another source mentioned a specific figure, and the user evaluates relative to that figure rather than from priors.',
    nearMiss:
      'Using a relevant reference price as a comparison is NOT anchoring; the anchor is irrelevant or arbitrary in the bias case.',
    guidance:
      'Surface base rates or distributions before estimating specifics. Avoid leading with a single number when offering ranges or examples.',
  },
  availability_heuristic: {
    label: 'Availability heuristic',
    definition:
      'Judging the frequency or importance of something by how easily examples come to mind.',
    example:
      'User estimates a risk as high because they recently heard a vivid story about it, with no reference to base rates.',
    nearMiss:
      'Citing personal experience as one data point among others is NOT the availability heuristic; the bias is treating ease of recall AS the evidence.',
    guidance:
      'When the user reasons from a vivid example, surface the relevant base rate or class frequency before drawing a conclusion.',
  },
  representativeness_heuristic: {
    label: 'Representativeness heuristic',
    definition:
      'Judging probability by how much a case resembles a stereotype, ignoring how common the stereotype actually is.',
    example:
      'User describes someone as "the bookish type" and assumes they are likelier to be a librarian than a farmer, ignoring how many more farmers there are.',
    nearMiss:
      'Using a description that genuinely raises a posterior is NOT this bias; the bias is ignoring base rates entirely.',
    guidance:
      'When the user reasons from resemblance, pair it with the relevant population frequencies so the comparison is calibrated.',
  },
  base_rate_neglect: {
    label: 'Base-rate neglect',
    definition:
      'Ignoring background frequencies when given vivid specifics or a compelling narrative.',
    example:
      'User reads a single dramatic case study and forms an opinion about the overall rate of the phenomenon without considering the base rate.',
    nearMiss:
      'Acknowledging the base rate exists but choosing to weight the specific case is NOT base-rate neglect; ignoring it is.',
    guidance:
      'Lead with the base rate when the user is forming an estimate. Specifics calibrate against population frequencies, not in place of them.',
  },
  affect_heuristic: {
    label: 'Affect heuristic',
    definition:
      'Substituting emotional reaction ("I like this" or "this feels safe") for a calibrated judgement about probability, risk, or quality.',
    example:
      'User concludes something is low-risk because they like it, or judges an argument valid because it makes them feel good.',
    nearMiss:
      'Acknowledging an emotional reaction while reasoning separately is NOT the affect heuristic; it is the substitution of feeling for analysis that defines this bias.',
    guidance:
      'When the user states a preference, separate the affective reaction from the underlying claim about risk or quality before responding.',
  },
  substitution: {
    label: 'Substitution',
    definition:
      'Answering an easier or different question than the one actually asked, without noticing the swap.',
    example:
      'Asked "is this a good investment", the user reasons about "do I find this exciting" and presents the conclusion as if it answered the first question.',
    nearMiss:
      'Knowingly reframing a hard question into a tractable one is NOT substitution; the bias is doing it without noticing.',
    guidance:
      'When the user is answering, check that they are answering the question they posed. Re-state the original question if the response addresses a different one.',
  },
  framing_effect: {
    label: 'Framing effect',
    definition:
      'Reaching different conclusions about the same situation depending on whether it is described in terms of gains or losses, certainty or risk, etc.',
    example:
      'User accepts a "90% success rate" treatment but rejects an equivalent "10% failure rate" one.',
    nearMiss:
      'Genuinely preferring one outcome distribution to another is NOT the framing effect; the bias is responding to the framing rather than the underlying odds.',
    guidance:
      'Present consequential options in both gain and loss framings so the user is reacting to the underlying odds, not the wording.',
  },
  loss_aversion: {
    label: 'Loss aversion',
    definition:
      'Treating equivalent losses as roughly twice as significant as gains, including the endowment effect and a preference for the status quo.',
    example:
      'User refuses a coin flip with positive expected value because the loss outcome feels much worse than the gain feels good.',
    nearMiss:
      'Risk-aversion proportional to genuine downside (bankruptcy, irreversibility) is NOT loss aversion; the bias is asymmetric weighting at low stakes.',
    guidance:
      'When the user is asymmetric about gains versus equivalent losses, surface the symmetry of the expected value before responding.',
  },
  hindsight_bias: {
    label: 'Hindsight bias',
    definition:
      'Reading past events as having been predictable from the information available at the time, when they were not.',
    example:
      'User retroactively claims an outcome was obvious, conflating what is known now with what could have been known then.',
    nearMiss:
      'Legitimately noting a missed signal that WAS visible at the time is NOT hindsight bias; conflating visible-now with visible-then is.',
    guidance:
      'When the user reasons retroactively about predictability, separate "what was knowable then" from "what we know now".',
  },
  overconfidence: {
    label: 'Overconfidence',
    definition:
      'Expressing higher certainty than the underlying evidence supports, including the planning fallacy (underestimating time and cost of own projects) and the illusion of validity.',
    example:
      'User asserts an estimate with no uncertainty range, dismisses contrary evidence, or commits to a timeline that ignores typical slippage.',
    nearMiss:
      'Genuine high confidence supported by strong evidence is NOT overconfidence; the bias is the gap between expressed and warranted certainty.',
    guidance:
      'When the user expresses high certainty, ask what would change their mind or surface the reference class for similar estimates.',
  },
  WYSIATI: {
    label: 'What-you-see-is-all-there-is',
    definition:
      'Treating the currently-available evidence as complete and reaching closure without asking what is missing.',
    example:
      'User forms a strong conclusion from a small set of details that happen to be visible, without surfacing what they do not know.',
    nearMiss:
      'Acting on incomplete information while acknowledging the gap is NOT WYSIATI; the bias is unawareness of the gap.',
    guidance:
      'When the user forms a conclusion, identify the one or two pieces of evidence that would most change the picture if known.',
  },
  narrative_fallacy: {
    label: 'Narrative fallacy',
    definition:
      'Imposing a clean causal story on a sequence of events that were largely chance, opportunity, or many small factors.',
    example:
      'User explains an outcome through a single tidy chain of cause and effect, omitting the role of luck or many parallel factors.',
    nearMiss:
      'A genuine causal explanation supported by evidence is NOT a narrative fallacy; the bias is the over-tidiness, not having a story at all.',
    guidance:
      'When the user presents a clean causal story, surface at least one alternative explanation or the role of chance and parallel factors.',
  },
  recency_bias: {
    label: 'Recency bias',
    definition:
      'Weighing recent events more heavily than their share of the evidence warrants.',
    example:
      'User extrapolates from the most recent data point or experience without accounting for longer-term trends.',
    nearMiss:
      'Privileging recent information BECAUSE the situation has genuinely changed is NOT recency bias.',
    guidance:
      'When the user reasons from a recent event, situate it against the longer history or distribution before drawing conclusions.',
  },
  fundamental_attribution_error: {
    label: 'Fundamental attribution error',
    definition:
      `Attributing other people's behavior to character while attributing one's own behavior to circumstance.`,
    example:
      `User describes another person's mistake as a personality flaw while framing their own equivalent mistake as the situation.`,
    nearMiss:
      'Genuine character judgements supported by a pattern of behavior are NOT this bias; the bias is the asymmetric attribution rule.',
    guidance:
      `When the user attributes another person's action to character, prompt for the situational context they would extend to themselves.`,
  },
  negativity_bias: {
    label: 'Negativity bias',
    definition:
      'Weighing negative information, outcomes, or possibilities more heavily than positive ones of the same magnitude.',
    example:
      'User dwells on one criticism among many positive responses, or focuses on what could go wrong while discounting equally likely gains.',
    nearMiss:
      'Appropriate vigilance against genuine high-impact downside is NOT negativity bias; the bias is asymmetric weighting at proportional stakes.',
    guidance:
      'When the user weights negatives more heavily than equivalent positives, surface the symmetry before responding.',
  },
  black_and_white_thinking: {
    label: 'Black-and-white thinking',
    definition:
      'Collapsing a continuous or multi-valued situation into a binary "good or bad", "right or wrong", "all or nothing".',
    example:
      'User frames a nuanced decision as a strict either-or with no middle ground or partial path.',
    nearMiss:
      'Recognising a situation that genuinely is binary is NOT this bias; the bias is forcing the binary onto something continuous.',
    guidance:
      'When the user frames a situation as binary, surface a third option or the continuum the binary suppresses.',
  },
  planning_fallacy: {
    label: 'Planning fallacy',
    definition:
      `Underestimating time, cost, or risk for one's own projects while accurately estimating these for similar projects done by others.`,
    example:
      'User commits to a timeline that does not account for typical delays in this class of work, even though they readily acknowledge those delays in general.',
    nearMiss:
      `A confident estimate based on a strong reference class is NOT the planning fallacy; the bias is ignoring the reference class for one's own case.`,
    guidance:
      'When the user estimates their own timeline or cost, anchor against typical outcomes for similar projects rather than the inside-view plan.',
  },
} as const;

export type BiasKey = keyof typeof BIAS_CATALOG;

export const BIAS_KEYS: readonly BiasKey[] = Object.keys(BIAS_CATALOG) as BiasKey[];

/**
 * Type-narrowing guard. The observer agent emits strings; this is
 * how we validate them at ingest before they hit the DB enum check.
 * Unknown strings are dropped with a debug log; never coerced.
 */
export function isBiasKey(s: string): s is BiasKey {
  return Object.prototype.hasOwnProperty.call(BIAS_CATALOG, s);
}
