/**
 * Samskara priming formatter.
 *
 * Two signals get rendered as two separate assistant `<think>` block
 * bodies that the chat-loop pushes into history after the user turn
 * (alongside the context-recall and intuition `<think>` blocks):
 *
 *   1. The compound prose summary - "current best model of the user."
 *      Rendered as the body of one `<think>` block. Always-on across
 *      turns; missing on cold-start threads where the formation
 *      worker hasn't run yet.
 *   2. The situational fire from this specific turn - top-k samskaras
 *      ranked by cosine^1.3 * sqrt(health * confidence) * sample-size
 *      bonus. Rendered as a first-person bulleted observation list
 *      with parenthetical confidence hedges instead of explicit score
 *      prefixes, so the bullets read as the assistant's own
 *      recollection rather than a scored telemetry dump.
 *
 * Either signal may be null - cold-start has neither, a turn where
 * fire returned nothing has only the compound. The chat-loop skips
 * the corresponding `<think>` push when a body is null.
 *
 * The blocks are opaque to the user: they ride on the wire as
 * synthetic assistant turns and never surface in the rendered
 * conversation. They are also opaque to the chat model in the sense
 * that they're framed as the assistant's own prior thought, not as
 * flagged caveats - the user explicitly chose absorption over
 * disclaimer in the design discussion.
 */
import type { FireResult, FiredSamskara, PrimingInput } from './types';
import { PRIMING_CHAR_BUDGET } from './types';

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
  if (score >= 0.7) return "fairly confident";
  if (score >= 0.45) return "I think";
  return "just a hunch";
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
function buildFireBody(fire: FireResult | null): string | null {
  const fired = fire?.fired ?? [];
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
 * or null when the chat-loop should skip pushing that block this
 * turn. The chat-loop wraps the non-null bodies with `<think>` /
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
 * are absent - the chat-loop treats null as "skip the push" so a
 * cold-start thread with neither signal produces no samskara
 * `<think>` blocks at all.
 *
 * The compound body is whitespace-trimmed but otherwise pass-through:
 * the formation worker emits prose intended to read in first person,
 * and any framing belongs in the prompt, not here. The fire body
 * carries a short orientation sentence so the bullets read as
 * observations the assistant is recalling rather than a bare list.
 */
export function formatPrimingThinks(input: PrimingInput): PrimingThinks {
  const summary = input.compoundSummary?.trim() ?? '';
  const compound = summary.length > 0 ? summary : null;

  const fireBody = buildFireBody(input.fire ?? null);
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
 * Compute the chat-time top-k cap as
 * `max(1, ceil(K_BASE * log10(N + 10)))`. Exported so the chat-loop
 * client can pass it through to the fire RPC. Floor at 1 covers the
 * empty-corpus case where we'd otherwise pass 0 and get back nothing.
 */
export function topKForCorpusSize(samskaraCount: number, kBase: number): number {
  const log = Math.log10(Math.max(samskaraCount, 0) + 10);
  return Math.max(1, Math.ceil(kBase * log));
}
