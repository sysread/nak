// Pure UI-behavior primitives for the intents inspector - the
// read-only "surfaced" surface for the intents feature ("surfaced, not
// steerable"). The Svelte components (IntentsPill, the Intents modal)
// are composition + DOM glue; every decision about grouping, labels,
// and how an efficacy posterior reads as plain language lives here and
// is unit-tested (tests/intents-inspector.test.ts). See
// docs/dev/in-progress/intents.md.
//
// Honesty is the design constraint of the inspector: it must show what
// each intention is *trying to do to the user*, not a euphemism, and it
// must not overstate efficacy. The label helpers below encode that.

import { BIAS_CATALOG } from '$lib/bias/catalog';
import { isBiasKey, type BiasKey } from '$lib/bias/catalog-keys';

export type IntentStatus = 'active' | 'dormant' | 'retired';
export type IntentTargetKind = 'bias' | 'samskara' | 'none';
export type IntentDirection = 'reduce' | 'reinforce';

/** One row from the `intents` table, as the inspector reads it. */
export interface IntentRow {
  id: string;
  statement: string;
  rationale: string | null;
  status: IntentStatus;
  target_kind: IntentTargetKind;
  target_ref: string | null;
  target_direction: IntentDirection | null;
  efficacy: number | null;
  created_at: string;
  updated_at: string;
  last_minted_at: string | null;
}

/** Intents partitioned by lifecycle, each sorted most-recent first. */
export interface GroupedIntents {
  active: IntentRow[];
  dormant: IntentRow[];
  retired: IntentRow[];
}

/**
 * Normalize a statement for cross-status duplicate detection. Mirrors
 * the minter's `normalizeStatement` (intent-mint.ts) so the inspector
 * collapses exactly the pairs the minter treats as the same goal: trim,
 * collapse internal whitespace, lowercase.
 */
function normKey(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Partition rows into active / dormant / retired, each sorted by
 * `updated_at` descending (freshest first). The inspector renders the
 * three groups as sections in that order - what Nak is pursuing now,
 * what it paused, what it let go.
 *
 * A retired row whose statement matches a currently-live (active or
 * dormant) one is a superseded earlier take of a goal Nak has since
 * picked back up. Showing it under "Let go" would surface the identical
 * sentence twice, which reads as a glitch - so it is dropped from the
 * retired group here, and the live card is flagged re-formed instead
 * (see `reformedIds`).
 */
export function groupByStatus(rows: readonly IntentRow[]): GroupedIntents {
  const byRecency = (a: IntentRow, b: IntentRow) =>
    b.updated_at.localeCompare(a.updated_at);
  const active = rows.filter((r) => r.status === 'active').sort(byRecency);
  const dormant = rows.filter((r) => r.status === 'dormant').sort(byRecency);
  const live = new Set([...active, ...dormant].map((r) => normKey(r.statement)));
  const retired = rows
    .filter((r) => r.status === 'retired' && !live.has(normKey(r.statement)))
    .sort(byRecency);
  return { active, dormant, retired };
}

/** Annotation shown on a live card that Nak let go of earlier and has
 * since re-formed - so an identical statement reappearing does not read
 * as a duplicate bug. */
export const REFORMED_NOTE =
  'Reconsidered - Nak set an earlier take on this aside, then took it back up.';

/**
 * Ids of active/dormant intents whose statement also appears on a
 * retired row - a goal that was let go and later re-formed. The
 * inspector annotates these (with `REFORMED_NOTE`) so the re-formed card
 * explains itself rather than looking like a duplicate of a tombstone
 * the user can no longer see.
 */
export function reformedIds(rows: readonly IntentRow[]): Set<string> {
  const retired = new Set(
    rows.filter((r) => r.status === 'retired').map((r) => normKey(r.statement)),
  );
  const out = new Set<string>();
  for (const r of rows) {
    if (r.status !== 'retired' && retired.has(normKey(r.statement))) out.add(r.id);
  }
  return out;
}

/** Plain-language view of an intent's efficacy, honest about uncertainty. */
export interface EfficacyView {
  state: 'freeform' | 'unscored' | 'landing' | 'mixed' | 'struggling';
  label: string;
  /** One-line explanation of what the state means; null when none needed. */
  hint: string | null;
}

// Bucket thresholds on the [0,1] posterior. These are display bands,
// deliberately coarse - the inspector should not imply more precision
// than a shrinkage estimate over a handful of weekly samples carries.
const LANDING_FLOOR = 0.6;
const STRUGGLING_CEIL = 0.4;

/**
 * Turn the efficacy posterior into a plain-language read. The honesty
 * rules: a free-form intent is NEVER scored (it has no measurable
 * target), so it reports 'freeform', not a fake number; a targeted
 * intent with no posterior yet reports 'unscored' ("too new to tell"),
 * never a default that looks like a verdict.
 */
export function efficacyView(row: IntentRow): EfficacyView {
  if (row.target_kind === 'none') {
    return {
      state: 'freeform',
      label: 'open-ended',
      hint: 'No measurable target - Nak follows this by feel, not a score.',
    };
  }
  if (row.efficacy == null) {
    return {
      state: 'unscored',
      label: 'too new to tell',
      hint: 'Not enough movement measured yet to say whether it is working.',
    };
  }
  if (row.efficacy >= LANDING_FLOOR) {
    return { state: 'landing', label: 'landing', hint: null };
  }
  if (row.efficacy < STRUGGLING_CEIL) {
    return {
      state: 'struggling',
      label: 'not landing',
      hint: 'The target is not moving the intended way more than it would anyway.',
    };
  }
  return { state: 'mixed', label: 'mixed', hint: null };
}

/**
 * Human-readable description of WHAT an intent is trying to shift -
 * stated plainly, not euphemized, because the inspector's whole job is
 * to let the user see the agenda. For a bias target it names the bias
 * from the catalog; for a samskara target it can only say "a predicted
 * pattern" (the ref is an opaque id, and surfacing the raw prediction
 * would collapse samskara's own absorption-over-disclosure framing); a
 * free-form intent has no target.
 */
export function targetLabel(row: IntentRow): string {
  if (row.target_kind === 'none' || !row.target_ref) {
    return 'no specific target';
  }
  const verb = row.target_direction === 'reinforce' ? 'leaning into' : 'easing';
  if (row.target_kind === 'bias') {
    const name = isBiasKey(row.target_ref)
      ? BIAS_CATALOG[row.target_ref as BiasKey].label.toLowerCase()
      : 'a cognitive pattern';
    return `${verb} ${name}`;
  }
  // samskara
  return `${verb} a predicted pattern`;
}

/**
 * Headline for the modal's count, pluralized. Counts only ACTIVE
 * intentions - the ones currently shaping replies - since that is what
 * the headline is reassuring the user about.
 */
export function activeHeadline(active: number): string {
  if (active === 0) return 'No intentions are active right now';
  if (active === 1) return 'Nak is working toward 1 intention with you';
  return `Nak is working toward ${active} intentions with you`;
}

/**
 * Relative-time formatter (injectable `now` for tests). Coarse on
 * purpose - the inspector shows "when", not a timestamp.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}
