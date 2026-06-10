/**
 * UI-behavior primitives for the Samskara diagnostics tab (Corpus +
 * Health panels). Pure functions only - no runes, no Svelte, no DOM, no
 * Supabase. The companion components (`SamskaraBrowseList.svelte`,
 * `SamskaraHealthPanel.svelte`, `Samskaras.svelte`) compose these with
 * framework-native reactivity.
 *
 * Everything a port to React/Solid/Vue would rewrite stays in the
 * components; everything else - sort/tier option lists, the
 * hide-similar collapse, the health-severity classification and its
 * thresholds, label/pluralization/relative-time helpers - lives here
 * and is unit-tested directly.
 */
import type {
  SamskaraBrowseSort,
  SamskaraCorpusRow,
  SamskaraWorkerLease,
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
 * Default cosine threshold for the "hide similar" slider, matching the
 * cohort dropdown's cluster default and the MINT dedup band. Higher
 * reads as "near-duplicate sentence", lower as "loosely related".
 */
export const DEFAULT_HIDE_SIMILAR_THRESHOLD = 0.85;

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

// --- Health severity ----------------------------------------------------

export type Severity = 'ok' | 'warn' | 'alarm';

/**
 * Thresholds for the Health panel's severity classification. Starting
 * defaults - tune against observed pipeline behaviour. Each pair is
 * [warn-at, alarm-at]: a value >= alarm-at is 'alarm', >= warn-at is
 * 'warn', else 'ok'. Backlogs tolerate a little depth (the worker
 * drains between turns); orphans and stuck claims should be ~0, so their
 * bars are tight.
 */
export const HEALTH_THRESHOLDS = {
  pendingAssimilate: [10, 50],
  pendingEmbed: [10, 50],
  firesAgedOut: [5, 25],
  orphanFires: [1, 5],
  stuckClaims: [1, 3],
} as const satisfies Record<string, readonly [number, number]>;

/** Classify a backlog/inconsistency count against a [warn, alarm] pair. */
export function severityFor(value: number, thresholds: readonly [number, number]): Severity {
  if (value >= thresholds[1]) return 'alarm';
  if (value >= thresholds[0]) return 'warn';
  return 'ok';
}

/** Compound-summary staleness, in hours, to severity. ok < 6h, warn < 24h, else alarm. */
export function compoundStaleness(lastRegenAt: string | null, now: number = Date.now()): Severity {
  if (!lastRegenAt) return 'warn'; // no summary yet is mild, not an alarm
  const ageH = (now - new Date(lastRegenAt).getTime()) / 3_600_000;
  if (Number.isNaN(ageH)) return 'warn';
  if (ageH >= 24) return 'alarm';
  if (ageH >= 6) return 'warn';
  return 'ok';
}

export interface LeaseLiveness {
  workerKind: string;
  /** True when the lease has not lapsed - a worker is actively holding it. */
  live: boolean;
  expiresAt: string;
}

/**
 * Resolve worker liveness for the kinds the samskara pipeline depends
 * on. A kind with no lease row, or a lapsed one, is not live - formation
 * (or substrate embedding) is silently stopped. Returns one entry per
 * requested kind, in the requested order, so the panel always renders a
 * fixed set of rows.
 */
export function leaseLiveness(
  leases: readonly SamskaraWorkerLease[],
  kinds: readonly string[],
  now: number = Date.now()
): LeaseLiveness[] {
  return kinds.map((kind) => {
    const lease = leases.find((l) => l.workerKind === kind);
    const live = lease ? new Date(lease.expiresAt).getTime() > now : false;
    return { workerKind: kind, live, expiresAt: lease?.expiresAt ?? '' };
  });
}

/** Worker kinds the samskara pipeline depends on, in panel display order. */
export const SAMSKARA_WORKER_KINDS = ['samskara', 'embedding'] as const;

/**
 * Worst severity across a set - for a single panel-level headline dot.
 * 'alarm' dominates 'warn' dominates 'ok'.
 */
export function worstSeverity(severities: readonly Severity[]): Severity {
  if (severities.includes('alarm')) return 'alarm';
  if (severities.includes('warn')) return 'warn';
  return 'ok';
}
