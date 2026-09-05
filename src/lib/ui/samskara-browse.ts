/**
 * UI-behavior primitives for the Samskara tab's Corpus browse list and
 * per-samskara detail pane. Pure functions only - no runes, no Svelte,
 * no DOM, no Supabase. The companion components
 * (`SamskaraBrowseList.svelte`, `Samskaras.svelte`) compose these with
 * framework-native reactivity.
 *
 * Everything a port to React/Solid/Vue would rewrite stays in the
 * components; everything else - sort/tier option lists, the
 * hide-similar collapse, provenance grouping, the per-samskara verdict
 * list, label/valence/relative-time formatters - lives here and is
 * unit-tested directly. The Health panel's severity toolkit lives in
 * the sibling ./samskara-health.ts; that panel also reads this
 * module's `relativeTime`, and the two verdict lists share this
 * module's VerdictCount shape.
 */
import type {
  SamskaraBrowseSort,
  SamskaraCorpusRow,
  SamskaraProvenanceRow,
} from '../supabase';

/** Debounce window between the last keystroke and the search round trip. Matches the other drawer tabs. */
export const SEARCH_DEBOUNCE_MS = 200;

/** Per-call cap for the corpus list/search - the corpus is small, so this is generous. */
export const CORPUS_LIST_LIMIT = 100;

/** Tier filter options for the Corpus segmented control. `null` = all tiers. */
export const TIER_FILTERS: readonly { value: number | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 1, label: 'Tier 1' },
  { value: 2, label: 'Tier 2' },
];

/** Sort options for the Corpus list, in display order. */
export const SORT_OPTIONS: readonly { value: SamskaraBrowseSort; label: string }[] = [
  { value: 'recent', label: 'Newest' },
  { value: 'strongest', label: 'Strongest' },
  { value: 'most_fired', label: 'Most fired' },
  { value: 'recently_fired', label: 'Recently fired' },
];

/**
 * Default CENTERED-cosine threshold for the "hide similar" slider
 * (both vectors have the user's corpus mean subtracted before the
 * cosine - see the samskara_centering table in schema.sql; every
 * samskara similarity dial shares this scale). 0.45 sits at the top
 * of the labeled duplicate/same-topic overlap zone (2026-09-05 probe
 * set), matching the mint dedup bar's neighbourhood: higher reads as
 * "near-duplicate sentence", lower folds same-topic siblings
 * together.
 */
export const DEFAULT_HIDE_SIMILAR_THRESHOLD = 0.45;

/** Empty-list message: distinguishes "search found nothing" from "cold corpus". */
export function emptyMessage(query: string): string {
  return query.trim().length > 0
    ? 'No matching samskaras.'
    : 'No samskaras yet. They form as you chat.';
}

/** "T1" / "T2" badge text for a tier. */
export function tierBadge(tier: number): string {
  return `T${tier}`;
}

/** Signed valence to one decimal, with an explicit leading + for positives. */
export function formatValence(v: number | null | undefined): string {
  if (v == null) return 'n/a';
  const r = Math.round(v * 10) / 10;
  return r > 0 ? `+${r.toFixed(1)}` : r.toFixed(1);
}

/**
 * Compact relative-time label ("3m ago", "2d ago", "never"). Injectable
 * `now` for deterministic tests.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const sec = Math.round((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/**
 * A corpus row plus how many near-duplicates the hide-similar slider
 * folded under it. `similarCount` is 0 when nothing was folded.
 */
export interface CollapsedRow {
  row: SamskaraCorpusRow;
  similarCount: number;
}

/**
 * Collapse near-duplicates for the hide-similar slider. Walks `rows` in
 * their existing order and keeps only the FIRST row seen for each
 * cluster sequence (the representative, since the list is already in the
 * panel's chosen order), annotating it with how many siblings the
 * cluster has beyond it. Rows with no cluster assignment (e.g. an
 * unembedded straggler the cluster RPC skipped) are always kept as their
 * own singletons. Pure: same inputs, same output.
 */
export function collapseSimilar(
  rows: readonly SamskaraCorpusRow[],
  clusterMap: ReadonlyMap<string, { seq: number; size: number }>
): CollapsedRow[] {
  const seenSeq = new Set<number>();
  const out: CollapsedRow[] = [];
  for (const row of rows) {
    const cluster = clusterMap.get(row.id);
    if (!cluster) {
      out.push({ row, similarCount: 0 });
      continue;
    }
    if (seenSeq.has(cluster.seq)) continue;
    seenSeq.add(cluster.seq);
    out.push({ row, similarCount: Math.max(cluster.size - 1, 0) });
  }
  return out;
}

/**
 * One-line summary of the hide-similar collapse for the muted label
 * under the slider: how many distinct samskaras remain after folding
 * near-duplicates, out of the full loaded set.
 */
export function matchSummary(shown: number, total: number): string {
  const hidden = Math.max(total - shown, 0);
  return `Showing ${shown} of ${total} - ${hidden} folded as similar`;
}

/**
 * Provenance kinds in display order: the substrate that formed the
 * samskara first, then the relations that tied that substrate together,
 * then (for a tier-2) its tier-1 children. A samskara minted from the
 * association graph is the first kind to carry MIXED provenance
 * (substrate + association), which is exactly why the detail view can no
 * longer label the whole section off the first row's kind.
 */
type ProvenanceKind = SamskaraProvenanceRow['kind'];
const PROVENANCE_ORDER: readonly ProvenanceKind[] = ['substrate', 'association', 'samskara'];
const PROVENANCE_HEADINGS: Record<ProvenanceKind, string> = {
  substrate: 'Formed from (substrate)',
  association: 'Related observations',
  samskara: 'Compounded from (tier-1 children)',
};

export interface ProvenanceGroup {
  kind: ProvenanceKind;
  heading: string;
  rows: SamskaraProvenanceRow[];
}

/**
 * Bucket provenance rows by kind into the display-ordered groups the
 * detail view renders, one headed section each. Empty kinds are
 * dropped, so a single-kind samskara still renders exactly one group -
 * preserving the prior one-heading behaviour without the first-row
 * heuristic that mislabels mixed provenance.
 */
export function groupProvenance(rows: readonly SamskaraProvenanceRow[]): ProvenanceGroup[] {
  const byKind = new Map<ProvenanceKind, SamskaraProvenanceRow[]>();
  for (const row of rows) {
    const list = byKind.get(row.kind);
    if (list) list.push(row);
    else byKind.set(row.kind, [row]);
  }
  const groups: ProvenanceGroup[] = [];
  for (const kind of PROVENANCE_ORDER) {
    const groupRows = byKind.get(kind);
    if (groupRows && groupRows.length > 0) {
      groups.push({ kind, heading: PROVENANCE_HEADINGS[kind], rows: groupRows });
    }
  }
  return groups;
}

export interface VerdictCount {
  label: string;
  count: number;
}

/**
 * Lifetime verdict breakdown for a single samskara's detail pane. Same
 * order as verdictBreakdown plus a trailing `pending` (fired but not yet
 * judged), which is meaningful per-samskara - it shows how much of this
 * prediction's firing history the judge has caught up on.
 */
export function verdictCountList(counts: {
  held: number;
  contradicted: number;
  notBorneOut: number;
  notEngaged: number;
  pending: number;
}): VerdictCount[] {
  return [
    { label: 'held', count: counts.held },
    { label: 'contradicted', count: counts.contradicted },
    { label: 'not-borne-out', count: counts.notBorneOut },
    { label: 'not-engaged', count: counts.notEngaged },
    { label: 'pending', count: counts.pending },
  ];
}

/*
 * Decay-standing primitives for the detail pane. The thresholds mirror
 * the SQL release machinery in schema.sql (samskara_reap_untested,
 * samskara_evict_for_mint) - keep them in lockstep, or the pane
 * predicts a fate the workers won't deliver.
 *
 * Deliberate omission: samskara_evict_for_mint's third tier (health
 * below 0.85 * the population prior p0) is NOT mirrored here. It
 * compares a row against a corpus-wide aggregate the pane never
 * fetches, so releaseStatus covers only the two row-local tiers; the
 * corpus-level "Evictable (... / unhealthy)" count on the Overview
 * card is where that tier surfaces.
 */

/** Days a never-genuinely-tested samskara survives before the hourly reaper releases it. */
export const PROBATION_DAYS = 45;
/** Judged fires (all not-engaged) that make an untested row evictable under cap pressure. */
export const EVICT_MIN_JUDGED = 10;
/** Newborn grace: rows younger than this are never evicted. */
export const EVICT_MIN_AGE_DAYS = 14;
/** Days since the last genuine verdict after which a weakly-established row becomes stale-evictable. */
export const STALE_EVICT_DAYS = 90;
/** Evidence-tally ceiling for "weakly established": at most one full test's worth. */
export const STALE_EVICT_MAX_TALLY = 1.0;

export interface EngagementSummary {
  /** Fires the next-day judge has ruled on (any verdict). */
  judged: number;
  /** Judged fires that genuinely engaged (held / contradicted / not-borne-out). */
  genuine: number;
  /** genuine/judged as a percent, or null when nothing has been judged yet. */
  ratePct: number | null;
}

/**
 * Collapse the verdict tally into the engagement read the decay
 * machinery keys on: of the fires the judge ruled on, how many
 * genuinely engaged (vs the loose not-engaged topical matches that
 * touch no evidence)?
 */
export function engagementSummary(counts: {
  held: number;
  contradicted: number;
  notBorneOut: number;
  notEngaged: number;
}): EngagementSummary {
  const genuine = counts.held + counts.contradicted + counts.notBorneOut;
  const judged = genuine + counts.notEngaged;
  return {
    judged,
    genuine,
    ratePct: judged > 0 ? Math.round((genuine / judged) * 100) : null,
  };
}

/**
 * One-line decay standing for the detail pane: is this row established
 * evidence, waiting on a pending judgment, or on its way out via
 * probation or eviction? Precedence mirrors the SQL guards: a genuine
 * test protects the row while its evidence lasts (a weakly-established
 * row goes stale-evictable 90 days after its last genuine verdict); a
 * pending fire defers every release path; then probation-due,
 * evictable, and the countdown.
 *
 * `evidenceTally` is the row's discounted confirm+disconfirm sum - the
 * "weakly established" test reads the same number the SQL stale tier
 * does, not the raw verdict counts.
 */
export function releaseStatus(
  createdAt: string,
  counts: {
    held: number;
    contradicted: number;
    notBorneOut: number;
    notEngaged: number;
    pending: number;
    lastGenuineAt: string | null;
  },
  evidenceTally: number,
  nowMs: number
): string {
  const { judged, genuine } = engagementSummary(counts);
  if (genuine > 0) {
    const label = `established - ${genuine} genuine ${genuine === 1 ? 'test' : 'tests'}`;
    if (counts.pending === 0 && evidenceTally <= STALE_EVICT_MAX_TALLY && counts.lastGenuineAt) {
      const staleDays = Math.floor((nowMs - new Date(counts.lastGenuineAt).getTime()) / 86_400_000);
      if (staleDays >= STALE_EVICT_DAYS) {
        return `weakly ${label}, last engaged ${staleDays}d ago - evictable if a new mint needs the slot`;
      }
    }
    return label;
  }
  if (counts.pending > 0) {
    return 'untested - awaiting judgment on recent fires';
  }
  const ageDays = (nowMs - new Date(createdAt).getTime()) / 86_400_000;
  const remaining = Math.ceil(PROBATION_DAYS - ageDays);
  if (remaining <= 0) {
    return 'untested past probation - released at the next hourly sweep';
  }
  if (judged >= EVICT_MIN_JUDGED && ageDays >= EVICT_MIN_AGE_DAYS) {
    return `untested despite ${judged} judged fires - evictable if a new mint needs the slot; probation in ${remaining}d`;
  }
  return `untested - released by probation in ${remaining}d unless genuinely tested`;
}
