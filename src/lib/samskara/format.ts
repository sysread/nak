/**
 * Priming-block formatter for the samskara feature.
 *
 * Two simultaneous signals get assembled into the per-turn appendix
 * the chat loop appends to the system prompt:
 *
 *   1. The compound prose summary (always-on across turns) — a few
 *      hundred tokens of "current best model of the user." Rendered
 *      as a leading paragraph.
 *   2. The situational fire from this specific turn — top-k samskaras
 *      ranked by cosine * sqrt(health * confidence). Rendered as a
 *      bullet list, weakest-but-relevant ones rendered in shortened
 *      form when budget tightens so the long tail stays present
 *      without dominating.
 *
 * Either signal may be empty (cold start has neither; a turn where
 * cosine fire returned nothing has only the compound). An entirely
 * empty input produces an empty string and the chat-loop appends
 * nothing.
 *
 * The block is opaque to the user — it lives in the system prompt and
 * never surfaces in the rendered conversation. It is also opaque to
 * the chat model in the sense that it's framed as plain context, not
 * as flagged "this might be wrong" caveats. The user explicitly chose
 * absorption over disclaimer in the design discussion.
 */
import type { FireResult, PrimingInput } from './types';
import { PRIMING_CHAR_BUDGET } from './types';

/**
 * Render a fire row's bullet line. Score is shown to two decimals so
 * the model has a sense of "this one fired strong vs this one was
 * marginal" without a precision war. Inner voice is prepended in
 * parens when present and short enough; truncated aggressively past
 * 80 chars (it's secondary signal at best, and a long inner-voice
 * fragment crowds the main prediction).
 */
function renderFireBullet(
  fire: FireResult['fired'][number],
  abbreviated: boolean
): string {
  const score = fire.score.toFixed(2);
  if (abbreviated) {
    // Abbreviated form: just score + prediction, no inner voice. Used
    // for long-tail entries when the budget is tight.
    return `- [${score}] ${fire.prediction}`;
  }
  const voice =
    fire.innerVoice && fire.innerVoice.length > 0 && fire.innerVoice.length <= 80
      ? ` (${fire.innerVoice})`
      : '';
  return `- [${score}] ${fire.prediction}${voice}`;
}

/**
 * Build the priming block. Returns the empty string when there's
 * nothing to emit so the chat-loop knows to skip the appendix
 * entirely.
 *
 * Budget enforcement is two-stage. First pass renders every fire
 * row in full form; if total length is over budget, abbreviated
 * form is used for all rows except the top three. The compound
 * summary is never trimmed — if it alone exceeds budget, we render
 * it in full and emit just the top fire, on the theory that the
 * compound is the higher-signal part and a recently-regenerated
 * summary deserves to land intact.
 */
export function formatPriming(input: PrimingInput): string {
  const sections: string[] = [];
  const summary = input.compoundSummary?.trim() ?? '';
  if (summary.length > 0) {
    sections.push('## Calibration', summary);
  }

  const fired = input.fire?.fired ?? [];
  if (fired.length > 0) {
    // Full form first; downgrade to abbreviated if we're over budget.
    let bullets = fired.map((f) => renderFireBullet(f, false));
    let body = bullets.join('\n');
    const overheadEstimate = sections.join('\n\n').length + 40;
    if (overheadEstimate + body.length > PRIMING_CHAR_BUDGET) {
      // Keep the top three in full form; abbreviate the rest. This
      // preserves headline detail on what mattered most while
      // leaving the long-tail signals visible to the model.
      bullets = fired.map((f, i) => renderFireBullet(f, i >= 3));
      body = bullets.join('\n');
    }
    // If still over budget, drop the lowest-scoring tail entries one
    // by one until we fit. The fire list is already sorted by score
    // descending so .pop() removes the weakest.
    while (
      bullets.length > 1 &&
      overheadEstimate + body.length > PRIMING_CHAR_BUDGET
    ) {
      bullets.pop();
      body = bullets.join('\n');
    }
    sections.push('## Fired this turn', body);
  }

  return sections.join('\n\n');
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
