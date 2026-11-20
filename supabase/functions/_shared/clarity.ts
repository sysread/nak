// The clarity standard (B8): shared by the browser (the system-prompt
// block + the settings-gated baseline) and the edge (the judge's
// criteria + the rewrite prompt). Single-sourced through the $shared
// alias - pure text + pure functions plus one setting-read helper for
// the edge agents' gated embeds; no globals (the venice-stream.ts
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
// evidence basis is honest: the clear-writing standard plus the
// ABSENCE of a recorded clarity incident - the sibling blocks each
// cite a dated observed failure; this one ships on
// standard-plus-absence, and the judge's logged scores are the data
// that will justify or retire it.
export const CLARITY_BLOCK = `\
Write so a busy reader parses every sentence on the first pass.
- Answer first: your first sentence carries the answer or the request. Reasons come after it; caveats come last.
- When you explain something or present detailed information, keep the same pyramid: the answer, then the mechanism, then the caveats - so the reader stops when satisfied, not when the reveal lands.
- One idea per sentence. One topic per paragraph.
- Common words over impressive ones. Keep a technical term when it is the precise name; introduce it with a short definition the first time it appears.
- Say what the thing does before naming it with a label.
- When a fact is missing from what you know, say so plainly and stop there.
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
    name: 'process narration',
    test: 'the text describes its own assembly or the writer\'s actions instead of stating the thing',
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

// The clarity score at or below which the rewrite fires. The score
// question's rubric is 0-INDEXED (live-verified 2026-11-19: a
// slop-riddled probe scored 1.26): 0 = riddled, 1 = multiple
// violations, 2 = minor, 3 = clean. The threshold sits between
// "multiple violations" (1) and "minor violations" (2) - a
// borderline score lands closer to 2 and stays.
export const REWRITE_SCORE_THRESHOLD = 1.5;

// The notice copy: assistant-voiced, first person, neutral about
// position (a fork at the original carries the chip but not the
// rewrite, so the copy must not say "below").
export const CLARITY_NOTICE =
  'That reply came out muddier than it should have been - let me restate it more clearly.';

/** The rewrite completion's "switch modes" user turn: the original
 *  (fenced - data, not directives), the evidence, the contract. */
export function buildClarityRewriteAsk(originalContent: string, findingsText: string): string {
  return [
    'Your reply above is accurate but scored poorly for clarity. Rewrite it: the same facts, the same language, nothing added - one idea per sentence, the answer first, common words. Code blocks stay exactly as they were.',
    '',
    'Your original reply:',
    `<original_reply>`,
    originalContent,
    `</original_reply>`,
    '',
    findingsText,
  ].join('\n');
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

/** Flatten findings + score into the rewrite prompt's evidence lines. */
export function describeFindings(findings: MechanicalFinding[], score: number): string {
  if (findings.length === 0) {
    return `Clarity score: ${score.toFixed(1)} of 4 (no mechanical flags).`;
  }
  const lines = findings.map((f) => `- ${f.rule}: "${f.excerpt}"`);
  return `Clarity score: ${score.toFixed(1)} of 4. Mechanical flags:\n${lines.join('\n')}`;
}
