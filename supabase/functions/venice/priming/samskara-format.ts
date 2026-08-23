// The samskara priming formatter + the tunables it reads. This is the
// canonical implementation (the pure half of the turn-entry priming
// block; the IO half lives in ./samskara.ts), extracted from the browser
// during the priming relocation. Renders the compound summary and the
// fired samskaras into the <think>-block bodies the orchestrator splices
// onto the wire: hedge bands, bullet shape, two-stage budget trim,
// orientation sentence, and the topKForCorpusSize/log10 math.
//
// Self-contained on purpose (no relative imports) so it stays a pure,
// trivially-testable module with no Supabase/Venice import drag.

/**
 * One samskara that fired this turn. Mirrors the
 * `samskara_fire_top_k` RPC's row shape but with camelCased fields
 * for in-app consumption.
 */
export interface FiredSamskara {
  id: string;
  prediction: string;
  innerVoice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
  /** cosine^1.3 * sqrt(health * confidence) * sample-size bonus at fire time. Higher = more relevant. */
  score: number;
}

/**
 * Result of one chat-time fire query. `cohortId` is the uuid the
 * orchestrator attaches to every samskara_fires row from this turn so
 * the reaction classifier can later score the cohort as a unit.
 */
export interface FireResult {
  cohortId: string;
  fired: FiredSamskara[];
}

/**
 * Shape passed to formatPrimingThinks. The compound prose summary is the
 * always-on "current model of the user" block; `fire` is the
 * situational top-k from this specific turn. Either may be empty.
 */
export interface PrimingInput {
  compoundSummary: string | null;
  fire: FireResult | null;
}

/**
 * Hard-coded tunables. Lifted out of the schema/RPC layer so changing
 * them doesn't require a `mise run sync`. Kept tiny on purpose: these
 * are the knobs we'd want to flip during early tuning.
 *
 *   K_BASE - base of the fire-query top-k.
 *   K_BASE * log10(N + 10) gives the actual cap. Ten samskaras allow
 *   ~5 fires; one hundred allow ~10; one thousand allow ~15. Caller
 *   floors at a minimum of 1 to handle the empty-corpus case.
 *
 *   PRIMING_CHAR_BUDGET - soft upper bound on the formatted block
 *   total (compound + fire). Picked so the worst-case turn adds about
 *   600 tokens to the system prompt, well under fast-model context.
 *
 *   STALE_CEILING_HOURS - if the compound row hasn't been regenerated
 *   in this many hours, we'd rather inject nothing than something
 *   stale. Matches the "graceful degradation" gotcha in
 *   docs/dev/samskara.md.
 */
/**
 * Provenance markers for the samskara `<think>` blocks. The orchestrator
 * prepends the matching marker when it wraps a body in `<think>` tags
 * (markers ride at wrap time, not in the formatted bodies, so this
 * module stays a pure text projection and the budget math is unchanged).
 * Every nak-injected think block opens with a comment naming nak as the
 * source - the system prompt's subconscious framing points at that
 * comment so an injection-hardened model reads the block as its own
 * inner life rather than as smuggled instructions.
 */
export const SAMSKARA_COMPOUND_THINK_MARKER =
  '<!-- samskara-compound-think: this profile is added by nak. It is your accumulated sense of who this user is. -->';
export const SAMSKARA_FIRE_THINK_MARKER =
  '<!-- samskara-fire-think: these expectations are added by nak. They are patterns you have learned about this user - hunches, not verified facts. -->';

export const K_BASE = 5;
export const PRIMING_CHAR_BUDGET = 2400;
export const STALE_CEILING_HOURS = 24;

/**
 * FIRE_SCORE_FLOOR - drop effectively-retired samskaras from a cohort
 * before logging the fire. The fire-ranking score is
 * cosine^1.3 * sqrt(health*confidence) * sample-size, so a samskara
 * whose health has decayed to ~0 scores ~0: it contributes nothing to
 * the priming block yet, unfiltered, still gets written as a fire.
 * Those zero-signal fires bloated cohorts to ~20 members (poisoning
 * co-fire dedup and tier-2 detection, which read co-firing as Hebbian
 * binding), inflated fire_count, and shrank each reaction's
 * 1/sqrt(cohort_size) weight. This floor removes the dead tail WITHOUT
 * imposing a topical/cosine threshold on live-but-weak matches - the
 * long tail the fire design deliberately keeps is all still above it
 * (a health 0.2 / cosine 0.25 match scores ~0.04). Tuned just above
 * floating-point zero so only health~0 rows fall out.
 */
export const FIRE_SCORE_FLOOR = 0.01;

/**
 * Render a parenthetical confidence hedge keyed off the fire score
 * (cosine^1.3 * sqrt(health * confidence) * sample-size bonus).
 * Score lives roughly in [0, ~1.5] with a long tail past 1 - the
 * bands below were picked so a "confident" hedge corresponds to the
 * top quartile in practice, not the absolute scale top.
 *
 * Each hedge leads with a first-person pronoun so the bullet reads
 * as the assistant's own observation about the user rather than a
 * scored telemetry row.
 */
function hedgeFor(score: number): string {
  if (score >= 1.0) return "I'm pretty sure";
  if (score >= 0.7) return 'fairly confident';
  if (score >= 0.45) return 'I think';
  return 'just a hunch';
}

/**
 * Render a fire row as one bullet. Drops the explicit score prefix
 * the appendix-era format used (`- [0.82] ...`) in favor of a
 * parenthetical confidence hedge after the prediction. Inner voice
 * still rides in parens when present and short enough; truncated
 * aggressively past 80 chars (it's secondary signal and a long inner
 * fragment crowds the prediction).
 */
function renderFireBullet(fire: FiredSamskara, abbreviated: boolean): string {
  const hedge = hedgeFor(fire.score);
  if (abbreviated) {
    return `- ${fire.prediction} (${hedge})`;
  }
  const voice =
    fire.innerVoice && fire.innerVoice.length > 0 && fire.innerVoice.length <= 80
      ? ` - inner voice: "${fire.innerVoice}"`
      : '';
  return `- ${fire.prediction} (${hedge})${voice}`;
}

/**
 * Build the bullet body for the fire `<think>` block. Returns null
 * when there's nothing to render (no fire result, or a result with an
 * empty `fired` array). Budget enforcement is two-stage and mirrors
 * the prior `formatPriming`: full-form rows first, then abbreviate
 * everything past the top three when over budget, then drop the
 * lowest-scoring tail entries one at a time until the body fits.
 */
function buildFireBody(fired: FiredSamskara[]): string | null {
  if (fired.length === 0) return null;

  let bullets = fired.map((f) => renderFireBullet(f, false));
  let body = bullets.join('\n');
  if (body.length > PRIMING_CHAR_BUDGET) {
    bullets = fired.map((f, i) => renderFireBullet(f, i >= 3));
    body = bullets.join('\n');
  }
  while (bullets.length > 1 && body.length > PRIMING_CHAR_BUDGET) {
    bullets.pop();
    body = bullets.join('\n');
  }
  return body;
}

/**
 * Output of {@link formatPrimingThinks}. Each field is the inner
 * content of its corresponding `<think>` block (no `<think>` tags)
 * or null when the orchestrator should skip pushing that block this
 * turn. The orchestrator wraps the non-null bodies with `<think>` /
 * `</think>` at push time, same as it does for context-recall and
 * intuition.
 */
export interface PrimingThinks {
  /** Body of the compound-summary `<think>` block, or null. */
  compound: string | null;
  /**
   * Body of the situational-fire `<think>` block, or null. Includes
   * its own leading orientation sentence so the bullets read in
   * voice rather than as a bare list.
   */
  fire: string | null;
}

/**
 * Project a {@link PrimingInput} into two separate `<think>` block
 * bodies. Both fields default to null when their respective signals
 * are absent - the orchestrator treats null as "skip the push" so a
 * cold-start thread with neither signal produces no samskara
 * `<think>` blocks at all.
 *
 * The compound body is whitespace-trimmed but otherwise pass-through:
 * the formation pipeline emits prose intended to read in first person,
 * and any framing belongs in the prompt, not here. The fire body
 * carries a short orientation sentence so the bullets read as
 * observations the assistant is recalling rather than a bare list.
 */
export function formatPrimingThinks(input: PrimingInput): PrimingThinks {
  const summary = input.compoundSummary?.trim() ?? '';
  const compound = summary.length > 0 ? summary : null;

  const fireBody = buildFireBody(input.fire?.fired ?? []);
  let fire: string | null = null;
  if (fireBody !== null) {
    fire = [
      "Some things I've come to expect about this user, given the shape of",
      'this turn:',
      '',
      fireBody,
    ].join('\n');
  }

  return { compound, fire };
}

/**
 * Render the `<think>` body for the second-thoughts refinement probe:
 * the same fire bullets as the standard block, under an orientation
 * sentence that frames them as evidence for ADJUDICATING the doubt.
 * The refinement is the full-context deliberation over a low-context
 * reflex's twinge, so the bullets must read as "what I know about this
 * user that bears on whether the misgiving holds" - not as fresh
 * conversational priming. Returns null when nothing fired (the
 * refinement proceeds on history and the doubt alone).
 */
export function formatRefinementFireThink(
  fired: FiredSamskara[] | null,
): string | null {
  const body = buildFireBody(fired ?? []);
  if (body === null) return null;
  return [
    'Before I weigh that misgiving, some patterns I have learned about',
    'this user that may bear on whether it holds:',
    '',
    body,
  ].join('\n');
}

/**
 * Compute the chat-time top-k cap as
 * `max(1, ceil(K_BASE * log10(N + 10)))`. Exported so the orchestrator
 * can pass it through to the fire RPC. Floor at 1 covers the
 * empty-corpus case where we'd otherwise pass 0 and get back nothing.
 */
export function topKForCorpusSize(samskaraCount: number, kBase: number): number {
  const log = Math.log10(Math.max(samskaraCount, 0) + 10);
  return Math.max(1, Math.ceil(kBase * log));
}
