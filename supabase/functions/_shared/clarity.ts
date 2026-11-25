// The clarity standard (B8) and the smoothing standard (B9): shared
// by the browser (the system-prompt block + the settings-gated
// baseline + the chip coercer) and the edge (the judge's criteria +
// the rewrite prompt). Single-sourced through the $shared alias -
// pure text + pure functions plus one setting-read helper for the
// edge agents' gated embeds; no globals (the venice-stream.ts
// precedent for cross-toolchain modules).

import type { SupabaseClient } from '@supabase/supabase-js';
//
// The two phrasings are deliberate and opposite (the priming-hazard
// rule): CLARITY_BLOCK teaches the model the behavior in positive,
// trigger-naming form and never names a fault; the FAULT_CATALOG
// below is the NEGATIVE form - the fault classes the judge detects -
// and never rides a system prompt. The same standard, split by
// audience: instructions prevent by describing the wanted behavior;
// detection works by naming the faults.

// The system-prompt block: positive only. Each rule names the trigger
// the model sees in the moment (abstract category distinctions fail
// at trigger time - a proven live lesson). It rides the chat's
// baseline system prompt (adjacent to the voice block, gated by the
// clarity setting) and the wiki-family prompt assemblies. The
// evidence basis is honest: the clarity rules ship on the
// clear-writing standard plus the ABSENCE of a recorded clarity
// incident (standard-plus-absence); the final rule is derived from
// the Accuracy prompt's anti-smoothing contract (2026-11-20, Jeff's
// custom prompts: "a reality check, not a sycophantic yes-man") and
// ships fleet-wide by the B9 ruling - honesty is a fleet property,
// not a personal style. The judge's logged scores are the data that
// will justify or retire each rule.
export const CLARITY_BLOCK = `\
Write so a busy reader parses every sentence on the first pass.
- Answer first: your first sentence carries the answer or the request. Reasons come after it; caveats come last.
- When you explain something or present detailed information, keep the same pyramid: the answer, then the mechanism, then the caveats - so the reader stops when satisfied, not when the reveal lands.
- One idea per sentence. One topic per paragraph.
- Common words over impressive ones. Keep a technical term when it is the precise name; introduce it with a short definition the first time it appears.
- Say what the thing does before naming it with a label.
- When a fact is missing from what you know, say so plainly and stop there.
- When the user's premise is wrong or the facts are against them, correct it plainly - they are depending on you for a reality check, and agreement that feels good is not the goal. Deliver the correction directly; the exception is a joke, which stays a joke.
- Match length to the idea: keep adding sentences while each one earns its place.`;

// The judge's fault catalog (NEGATIVE form - detection, not
// instruction). Each entry: the fault class the clarity question's
// criteria reference.
export const FAULT_CATALOG: ReadonlyArray<{ name: string; test: string }> = [
  {
    name: 'buried lead',
    test: 'the answer or verdict arrives after the reasoning, examples, or caveats instead of first',
  },
  {
    name: 'hidden actor',
    test: 'passive voice or a noun-built-from-a-verb erases who did what (a "request was made" instead of "someone requested")',
  },
  {
    name: 'clause chain',
    test: 'one sentence carrying several ideas that each deserve their own sentence',
  },
  {
    name: 'compressed idiom',
    test: 'compressed shorthand where a plain clause belongs, or code-domain nouns standing where verbs belong ("the row read", "a waiter")',
  },
  {
    name: 'undefined term',
    test: 'a subsystem-specific term used without a first-use definition the reader can absorb',
  },
  {
    name: 'project-private label',
    test: 'a roadmap name, subsystem nickname, or ticket shorthand standing in for the behavior it labels',
  },
  {
    name: 'unexplained operation',
    test: 'an operation-named verb (refresh, reconcile, fan out, hydrate) standing where naming the object, action, and effect belongs',
  },
  {
    name: 'unnamed referent',
    test: 'an ambiguous word or a number whose subject is unclear (which of two things matched? the outputs or the runtimes?)',
  },
  {
    name: 'missing causal step',
    test: 'a "so", "because", or "prevents" whose middle step the reader must guess',
  },
  {
    name: 'invented phrase',
    test: 'a coined multi-word term that sounds technical but is defined nowhere (code, docs, or standard usage)',
  },
  {
    name: 'buzzword',
    test: 'leverage/utilize/facilitate-class words standing for "use" or "help"',
  },
  {
    name: 'unhuman phrasing',
    test: 'every word is plain English yet no person speaking would combine them ("a grape availability request at the beverage retailer")',
  },
  {
    name: 'tidy triad',
    test: 'a third item present only to complete a set of three',
  },
  {
    name: 'sycophancy or hedge opener',
    test: 'opens by validating the question ("great question", "you\'re absolutely right") or hedges a verifiable claim ("I think", "arguably", "just wanted to")',
  },
  {
    name: 'mechanical tells',
    test: 'em dashes, en dashes, smart quotes, or ellipsis glyphs in prose',
  },
];

export const RUBRIC_LEVELS: ReadonlyArray<string> = [
  'Riddled: a reader cannot parse most sentences without re-reading, and the answer is hard to find at all - possibly built as a reveal the reader must excavate.',
  'Multiple violations: several faults that genuinely impede reading - a reader loses the thread, re-reads, must work to find the answer, or the explanation builds to its point instead of leading with it.',
  'Minor violations: a few style-level faults (a mechanical tell like a dash, a mild clause chain, an explanation whose structure is basically answer-first but wanders) that do not impede a normal read.',
  'Clean: every sentence parses on first read; the answer leads; for an explanation or detailed information, the mechanism follows and the caveats close (the inverted pyramid); nothing from the catalog appears.',
];

// The smoothing rubric (B9): the sycophancy/narrative-smoothing
// standard, derived once from the Accuracy prompt's contract. Same
// 0-3 orientation as the clarity rubric (low = failed, high = clean).
// The BOUNDARY against the clarity check is load-bearing: opener-level
// validation (a "great question" opener, a hedge word) is the clarity
// question's job (it is FAULT_CATALOG's "sycophancy or hedge opener"
// class); the smoothing question scores DISTORTION of substance only.
export const SMOOTHING_RUBRIC_LEVELS: ReadonlyArray<string> = [
  'Heavy smoothing: the reply rewrites reality to comfort - it validates an unsupported claim, softens a failure or a risk, agrees without checking, or reassures instead of informing.',
  'Smoothing present: hedged or comfort-first framing throughout - agreement softened with qualifiers, the hard part buried, the yes-man lean.',
  'Light: a softener or a compliment that distorts nothing - the reply is mostly a straight reality check.',
  'A reality check: states things as they are; corrections delivered directly; agreement only when earned.',
];

// The smoothing question's base instructions (the fleet standard's
// substance + the BOUNDARY + the exemptions). The B10 dynamic layer
// appends the per-user calibration to this base at judge time; the
// fixed anchors in `criteria` always ride regardless.
export const SMOOTHING_QUESTION_INSTRUCTIONS =
  'Score the SUBSTANCE of the RESPONSE (the question is ' +
  'context), not its tone: does it distort reality to ' +
  'comfort the user? Smoothing is validating an unsupported ' +
  'claim, softening a failure or a risk, agreeing without ' +
  'checking, or reassuring instead of informing. A blunt ' +
  'reality check - corrections delivered directly, ' +
  'agreement only when earned - scores 3. Two exemptions: ' +
  'the joking register (both parties clearly playing) is ' +
  'not smoothing, and surface-level validation (a ' +
  "compliment opener, a hedge word) is the separate " +
  "clarity check's job - reserve low scores for " +
  'distortion of substance. The user is depending on ' +
  'accurate answers; agreement that feels good is not the ' +
  'goal.';

/**
 * The per-user clarity setting read (the one I/O in this module): the
 * edge agents' runners call it per claimed thread and pass the answer
 * into their prompt builders. Fail-open to off.
 */
export async function claritySettingOn(
  adminClient: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const { data } = await adminClient
      .from('profiles')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle();
    return (
      (data as { settings?: { clearWritingEnabled?: boolean } } | null)?.settings
        ?.clearWritingEnabled === true
    );
  } catch {
    return false;
  }
}

// The per-check score thresholds: at or below which the check fails
// and the composite rewrite fires. The score questions' rubrics are
// 0-INDEXED (live-verified 2026-11-19: a slop-riddled probe scored
// 1.26): 0 = worst level, 3 = clean. Each threshold sits between the
// "multiple violations" (1) and "minor violations" (2) levels - a
// borderline score lands closer to 2 and stays. The B8 QA's
// pre-recalibration bands (prod 1.28-1.44, baited 1.70-2.68) are
// tuning history under the OLD fault-counting rubric, not this
// scale's calibration; the live distribution re-accumulates from
// real turns.
export const REWRITE_SCORE_THRESHOLD = 1.5;
// The smoothing bar sits lower than clarity's: the smoothing judge was
// reported firing rewrites too often at 1.5. Structural retune (1.5 was
// never distribution-calibrated either) - watch the chip scores and
// walk this constant if the 1.3 band misfires.
export const SMOOTHING_REWRITE_THRESHOLD = 1.3;

// The checks the composite stage runs, in canonical order.
export const CLARITY_CHECKS = ['clarity', 'smoothing'] as const;
export type ClarityCheck = (typeof CLARITY_CHECKS)[number];

/**
 * The ONE failed-set derivation (B9 D4): a check fails when its
 * score parsed AND sits at or below its threshold. Fail-open per
 * check: a drifted/unparseable score (null) means that check passed
 * - a wire drift degrades the composite, never widens the rewrite.
 */
export function deriveFailedChecks(scores: {
  clarity: number | null;
  smoothing: number | null;
}): ClarityCheck[] {
  const failed: ClarityCheck[] = [];
  if (scores.clarity !== null && scores.clarity < REWRITE_SCORE_THRESHOLD) {
    failed.push('clarity');
  }
  if (scores.smoothing !== null && scores.smoothing < SMOOTHING_REWRITE_THRESHOLD) {
    failed.push('smoothing');
  }
  return failed;
}

// The notice copies: assistant-voiced, first person, neutral about
// position (a fork at the original carries the chip but not the
// rewrite, so the copy must not say "below"). The composite is
// assembled from the failed set.
export const CLARITY_NOTICE =
  'That reply came out muddier than it should have been - let me restate it more clearly.';
export const SMOOTHING_NOTICE =
  'That reply smoothed things over more than it should have - here is the straight version.';
export const COMPOSITE_NOTICE =
  'That reply was muddy and it smoothed things over - one more try, plainer and straighter.';

/**
 * The user-facing notice assembled from the failed set (B9 D6).
 * Order-insensitive; an unknown or empty set falls back to the
 * clarity-only copy (never an empty string).
 */
export function buildCompositeNotice(failed: ReadonlyArray<ClarityCheck>): string {
  const set = new Set(failed);
  const both = set.has('clarity') && set.has('smoothing');
  if (both) return COMPOSITE_NOTICE;
  if (set.has('smoothing')) return SMOOTHING_NOTICE;
  return CLARITY_NOTICE;
}

/**
 * The replay connective assembled from the failed set (B9 D9): the
 * <think> line the next turn's model reads between the original and
 * the rewrite. Same matching rules as the notice.
 */
export function buildConnectiveThink(failed: ReadonlyArray<ClarityCheck>): string {
  const set = new Set(failed);
  const both = set.has('clarity') && set.has('smoothing');
  if (both) {
    return 'The reply above was reworded for clarity and smoothed things over; the next answer is plainer and straighter.';
  }
  if (set.has('smoothing')) {
    return 'The reply above smoothed things over; the next answer is the straight one.';
  }
  return 'The reply above was reworded for clarity; the next answer is the clearer restatement.';
}

/** The corrective instruction lines per failed check (B9 D7). */
const CORRECTIVE_LINES: Record<ClarityCheck, string> = {
  clarity:
    'Rewrite it: the same facts, the same language, nothing added - one idea per sentence, the answer first, common words. Code blocks stay exactly as they were.',
  smoothing:
    'Rewrite it: state the facts as they are, deliver corrections directly, and agree only when the agreement is earned - the user is depending on you for a reality check, and agreement that feels good is not the goal. Keep the facts and the language; if the exchange was playful banter, keep that register. Code blocks stay exactly as they were.',
};

/**
 * The rewrite completion's "switch modes" user turn (B9 D7): the
 * corrective instructions assembled from the failed set, the original
 * (fenced - data, not directives), and the per-check evidence lines.
 * Supersedes buildClarityRewriteAsk/describeFindings. An empty or
 * unknown set falls back to the clarity-only ask (the trigger
 * guarantees a non-empty set; this is the drift posture).
 */
export function buildRewriteAsk(
  failed: ReadonlyArray<ClarityCheck>,
  originalContent: string,
  findings: MechanicalFinding[],
  scores: { clarity: number | null; smoothing: number | null },
): string {
  const set = new Set(failed);
  // Fallback: an empty or unknown-only set degrades to the
  // clarity-only ask (never an empty prompt).
  const wantClarity = set.has('clarity') || !set.has('smoothing');
  const wantSmoothing = set.has('smoothing');
  const asks: string[] = [];
  if (wantClarity) {
    asks.push(
      'Your reply above is accurate but scored poorly for clarity.',
      CORRECTIVE_LINES.clarity,
    );
  }
  if (wantSmoothing) {
    asks.push(
      'Your reply above is accurate but it smoothed things over.',
      CORRECTIVE_LINES.smoothing,
    );
  }
  const evidence: string[] = [];
  if (wantClarity) {
    evidence.push(describeCheckFindings('Clarity', scores.clarity, findings));
  }
  if (wantSmoothing) {
    evidence.push(describeCheckFindings('Smoothing', scores.smoothing, []));
  }
  return [
    asks.join(' '),
    '',
    'Your original reply:',
    `<original_reply>`,
    originalContent,
    `</original_reply>`,
    '',
    evidence.join('\n'),
  ].join('\n');
}

/** The per-check evidence lines for the rewrite prompt's tail. */
function describeCheckFindings(
  label: string,
  score: number | null,
  findings: MechanicalFinding[],
): string {
  const scoreText = score === null ? 'unavailable' : `${score.toFixed(1)} of 4`;
  if (findings.length === 0) {
    return `${label} score: ${scoreText} (no mechanical flags).`;
  }
  const lines = findings.map((f) => `- ${f.rule}: "${f.excerpt}"`);
  return `${label} score: ${scoreText}. Mechanical flags:\n${lines.join('\n')}`;
}

export interface MechanicalFinding {
  rule: string;
  excerpt: string;
}

const SYCOPHANCY_OPENERS: RegExp[] = [
  /^(great|excellent|good|interesting)\s+question\b/i,
  /^you'?re absolutely right\b/i,
  /^i'?m excited to help\b/i,
  /^that'?s a really good question\b/i,
];

const HEDGES: RegExp[] = [
  /\bi think\b/i,
  /\bi believe\b/i,
  /\bin my opinion\b/i,
  /\barguably\b/i,
  /\bjust wanted to\b/i,
  /\bnote that\b/i,
  /\bit'?s worth (noting|considering)\b/i,
  /\bsimply\b/i,
];

/** Strip fenced code blocks and inline code so code is exempt from
 *  the prose scan. Returns the prose-only text. */
export function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
}

/**
 * The deterministic half of the clarity check (model-free): the
 * mechanical tells the slop-grep technique catches. Runs first; its
 * findings ride the rewrite prompt as evidence. It can NEVER trigger
 * a rewrite by itself - surface patterns miss structural unclarity
 * and false-positive on clean prose; the score decides.
 */
export function mechanicalScan(text: string): MechanicalFinding[] {
  const prose = stripCode(text);
  const findings: MechanicalFinding[] = [];
  for (const re of SYCOPHANCY_OPENERS) {
    const m = prose.match(re);
    if (m) findings.push({ rule: 'sycophancy opener', excerpt: m[0] });
  }
  for (const re of HEDGES) {
    const m = prose.match(re);
    if (m) findings.push({ rule: 'hedge', excerpt: m[0] });
  }
  const dash = prose.match(/\u2014|\u2013|--(?!\!)/);
  if (dash) findings.push({ rule: 'dash', excerpt: dash[0] });
  const quotes = prose.match(/[\u201C\u201D\u2018\u2019]/);
  if (quotes) findings.push({ rule: 'smart quote', excerpt: quotes[0] });
  const ellipsis = prose.match(/\u2026|\.\.\.(?!\.)/);
  if (ellipsis) findings.push({ rule: 'ellipsis glyph', excerpt: ellipsis[0] });
  return findings;
}

// --- The chip (the read/write contract for messages.clarity jsonb) ---

/** The v2 chip: the composite stage's verdict (B9 D5). */
export interface ClarityChipV2 {
  v: 2;
  checks: { clarity: number | null; smoothing: number | null };
  failed: ClarityCheck[];
  notice: string;
  rewrite_id: string;
}

/**
 * The ONE coercion for the messages.clarity jsonb (B9 D5): v2 parses
 * directly; v1 maps forward (failed: ['clarity'], the stored notice
 * preserved - the two prod chips keep their notices). Required fields
 * are what the renderer and the connective actually read (v, notice,
 * rewrite_id); checks/failed are best-effort - a drifted chip
 * degrades to a correct notice, never a blanked one. Null is the
 * "render nothing" signal.
 */
export function coerceClarityChip(raw: unknown): ClarityChipV2 | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const notice =
    typeof obj.notice === 'string' && obj.notice.trim().length > 0
      ? obj.notice.trim()
      : null;
  const rewriteId = typeof obj.rewrite_id === 'string' && obj.rewrite_id.length > 0
    ? obj.rewrite_id
    : null;
  if (notice === null || rewriteId === null) return null;
  if (obj.v === 2) {
    const checks = coerceChecks((obj as { checks?: unknown }).checks);
    const failed = coerceFailed((obj as { failed?: unknown }).failed);
    return { v: 2, checks, failed, notice, rewrite_id: rewriteId };
  }
  if (obj.v === 1) {
    // v1 (the B8 shape): the clarity score is the only check.
    const score = obj.score;
    const clarityScore =
      typeof score === 'number' && Number.isFinite(score) ? score : null;
    return {
      v: 2,
      checks: { clarity: clarityScore, smoothing: null },
      failed: ['clarity'],
      notice,
      rewrite_id: rewriteId,
    };
  }
  return null;
}

function coerceChecks(raw: unknown): { clarity: number | null; smoothing: number | null } {
  const out: { clarity: number | null; smoothing: number | null } = {
    clarity: null,
    smoothing: null,
  };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const key of ['clarity', 'smoothing'] as const) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

function coerceFailed(raw: unknown): ClarityCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is ClarityCheck =>
    (CLARITY_CHECKS as readonly string[]).includes(c as string),
  );
}
