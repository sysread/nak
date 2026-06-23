// bias-format -----------------------------------------------------------------
//
// Deno mirror of src/lib/bias/format.ts. Renders the "User profile -
// observed cognitive patterns" block that rides in the main chat LLM's
// system prompt, from the sweep-maintained bias_summary cache. The
// browser used to render this at turn entry and bake it into the
// system prompt it POSTed; priming now runs server-side, so the
// orchestrator renders it here instead and appends it to the system
// message before the first round.
//
// Mirror-with-pointer-comment convention (see the header of
// tests/bias-catalog-parity.test.ts): the two runtimes cannot share an
// import, so the render logic lives twice. The DATA it reads (the
// catalog, the tier math) is the parity-tested pair bias-catalog.ts /
// bias-math.ts; this file is the logic twin of src/lib/bias/format.ts.
// Keep the two in lockstep - a change to the block copy or the
// render-cap ordering here must land in the browser file too (and vice
// versa) until the browser copy is retired.
//
// One deliberate divergence from the browser twin: that file
// dynamic-imports BIAS_CATALOG to keep the bulky descriptions table out
// of the main chunk. Deno has no chunk-splitting concern, so this file
// static-imports it and renders synchronously.
import { type BiasKey, isBiasKey, BIAS_CATALOG } from './bias-catalog.ts';
import { type Tier } from './bias-math.ts';

/** Max biases rendered into the system-prompt block. Mirrors
 *  RENDER_CAP in src/lib/bias/types.ts. Even when more biases clear
 *  strong tier, only the top RENDER_CAP by ciLower descending make it
 *  into the prompt; the debug modal shows all rows regardless. */
export const RENDER_CAP = 4;

/** A cached aggregate row read from bias_summary. Mirrors
 *  BiasSummaryRow in src/lib/bias/types.ts. */
export interface BiasSummaryRow {
  bias: BiasKey;
  effectiveN: number;
  posteriorAlpha: number;
  posteriorBeta: number;
  posteriorMean: number;
  ciLower: number;
  feedbackScore: number;
  tier: Tier;
  computedAt: string;
}

/**
 * Sort key: strong tier rows ahead of soft, then by ciLower
 * descending within each tier so the strongest signal lands first.
 */
function biasRank(row: BiasSummaryRow): number {
  const tierWeight = row.tier === 'strong' ? 0 : row.tier === 'soft' ? 1 : 2;
  // Subtract ciLower so higher LB sorts first; multiply by a large
  // constant on tier so tier dominates over the LB ordering.
  return tierWeight * 10 - row.ciLower;
}

/**
 * Pick the renderable subset from a full bias_summary read. Filters
 * out 'elided' rows entirely, sorts by tier-then-LB-descending,
 * caps at RENDER_CAP.
 */
export function pickRenderable(rows: readonly BiasSummaryRow[]): BiasSummaryRow[] {
  const filtered = rows.filter((r) => r.tier === 'soft' || r.tier === 'strong');
  filtered.sort((a, b) => biasRank(a) - biasRank(b));
  return filtered.slice(0, RENDER_CAP);
}

/**
 * Render the system-prompt block. Returns null when no biases clear
 * soft/strong - same convention samskara's compound summary uses for
 * the null state. The caller omits the section entirely rather than
 * rendering a placeholder.
 */
export function formatBiasProfileBlock(
  rows: readonly BiasSummaryRow[],
): string | null {
  const picks = pickRenderable(rows);
  if (picks.length === 0) return null;

  const bullets: string[] = [];
  for (const row of picks) {
    if (!isBiasKey(row.bias)) continue;
    const entry = BIAS_CATALOG[row.bias as BiasKey];
    const tierWord = row.tier === 'strong' ? 'Consistently' : 'Occasionally';
    bullets.push(`- ${tierWord} ${entry.label.toLowerCase()}: ${entry.guidance}`);
  }
  if (bullets.length === 0) return null;

  return [
    '# User profile - observed cognitive patterns',
    '',
    'These patterns have shown up across the user\'s past conversations. Compensate in how you phrase responses; do not name the patterns or call them out unless the user explicitly invites that level of meta-discussion or you judge that naming will help with a high-stakes decision they are working through. The default is silent compensation.',
    '',
    ...bullets,
    '',
    'General framing rules that apply across all observed patterns:',
    '',
    '- Do not pre-anchor numbers, recommendations, or option framings. Present alternatives with comparable weight.',
    '- Surface base rates or class frequencies before estimating specifics.',
    '- When the user states a position, name at least one credible contrary view rather than only elaborating their framing.',
    '- Evaluate decisions on marginal grounds and future expected value, not on what has already been invested.',
    '- Phrase clarifying questions neutrally rather than leading.',
    '',
    'These rules apply to factual, decisional, or analytical exchanges. They do NOT apply to jokes, banter, whimsy, fiction, role-play, hypotheticals presented for fun, or any register where the user has signalled they are playing. In those registers, suspend the above rules entirely - calling out a "bias" in someone\'s bit is pedantic and breaks the exchange. Resume normal framing when the register returns to factual or decisional content. Use your judgement on where the line is; when ambiguous, default to the user\'s register.',
  ].join('\n');
}
