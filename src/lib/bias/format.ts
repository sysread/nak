/**
 * Pure formatter for the "User profile - observed patterns" block
 * that rides in the main chat LLM's system prompt. Reads the
 * worker-maintained bias_summary cache, takes only the rows
 * tiered 'soft' or 'strong', and renders the block as ASCII.
 *
 * Two pieces of static prompt copy live here:
 *
 *   - The framing rules that apply WHENEVER any bias is at soft+.
 *     These are general bias-aware framing instructions (don't
 *     pre-anchor, surface base rates, name a contrary view, etc.)
 *     plus the whimsy exception (suspend the rules in jokes /
 *     fiction / role-play). They are NOT per-bias.
 *
 *   - Per-bias guidance strings live in catalog.ts. The render
 *     pass interpolates them under the soft/strong header.
 *
 * Render cap (RENDER_CAP) is applied at the render layer, not in
 * the math: even when ten biases clear strong tier, only the top
 * four by ciLower descending make it into the prompt. The debug
 * modal shows all rows regardless.
 */
// BIAS_CATALOG (the bulky descriptions object) is dynamic-imported
// inside formatBiasProfileBlock so it doesn't ride into the main
// chunk via the chat-loop -> bias/index -> format path. The keys
// module is small enough to stay eager (it carries only the
// closed-enum machinery the chat loop's validators need).
import type { BiasKey } from './catalog-keys';
import { isBiasKey } from './catalog-keys';
import { RENDER_CAP, type BiasSummaryRow } from './types';

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
 * Render the system-prompt block. Returns null when no biases
 * clear soft/strong - same convention samskara's compound summary
 * uses for the null state. The caller (buildSystemPrompt) omits
 * the section entirely rather than rendering a placeholder.
 */
export async function formatBiasProfileBlock(
  rows: readonly BiasSummaryRow[]
): Promise<string | null> {
  const picks = pickRenderable(rows);
  if (picks.length === 0) return null;

  // Pull the catalog only when we actually have biases to render -
  // the chunk fetch is amortised across turns (browser module cache
  // makes it a one-shot per session) and lets the bulky descriptions
  // table stay out of main.
  const { BIAS_CATALOG } = await import('./catalog');

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
