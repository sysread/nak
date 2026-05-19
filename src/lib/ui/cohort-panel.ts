/**
 * UI-behavior primitives for the cohort diagnostic panel mounted
 * inline under each user message in the chat transcript. Pure
 * functions only - no runes, no Svelte imports, no DOM access. The
 * companion `src/components/CohortPanel.svelte` composes these with
 * its own runes (`raw`, `expandedClusters`) and renders the result.
 *
 * The decisions encoded here are the ones a port to another
 * framework would carry across unchanged: how fires are sorted, how
 * the cluster map turns into a list of cluster views (including
 * the negative-fallback-seq rule for unassigned fires), the three-
 * state confirmation label, the substrate assimilation state
 * machine, and the relative-time + valence formatters.
 *
 * Type imports from `$lib/supabase` are fine - the row shapes are
 * domain types, not framework types. A React port would still
 * consume `SamskaraFireDiagnosticRow`.
 */
import type {
  SamskaraFireDiagnosticRow,
  SamskaraSubstrateDiagnosticRow,
} from '../supabase';

/**
 * One bucket of fires that the cluster-RPC grouped together by
 * cosine-similarity. The representative is the strongest member
 * (highest score) and is what the panel renders first; siblings
 * sit behind a chevron chip the user can expand for paraphrase
 * inspection.
 */
export interface ClusterView {
  seq: number;
  representative: SamskaraFireDiagnosticRow;
  siblings: SamskaraFireDiagnosticRow[];
}

/**
 * Sort fires highest-score-first so the "representative" of any
 * cluster is the strongest member. Returns a fresh array; the
 * input is not mutated.
 */
export function sortFiresByScore(
  fires: readonly SamskaraFireDiagnosticRow[]
): SamskaraFireDiagnosticRow[] {
  return [...fires].sort((a, b) => b.score - a.score);
}

/**
 * Bucket the supplied fires into cluster views using the thread-
 * wide assignment map. Caller MUST pass fires already sorted by
 * score (see `sortFiresByScore`) so the first member of each
 * bucket is the cluster's representative.
 *
 * Fires without a cluster assignment each get a unique negative
 * fallback seq so they render as their own singleton. Using `?? 0`
 * would silently collapse every unassigned fire into one bucket
 * and produce duplicate each-block keys.
 *
 * Returns the cluster list sorted by representative score, so the
 * strongest theme appears first.
 */
export function clusterFires(
  sortedFires: readonly SamskaraFireDiagnosticRow[],
  clusterMap: ReadonlyMap<string, { clusterSeq: number; clusterSize: number }>
): ClusterView[] {
  const bySeq = new Map<number, SamskaraFireDiagnosticRow[]>();
  let nextFallbackSeq = -1;
  for (const f of sortedFires) {
    const assigned = clusterMap.get(f.id);
    const seq = assigned?.clusterSeq ?? nextFallbackSeq--;
    const bucket = bySeq.get(seq);
    if (bucket) bucket.push(f);
    else bySeq.set(seq, [f]);
  }
  return [...bySeq.entries()]
    .map(([seq, members]) => ({
      seq,
      representative: members[0],
      siblings: members.slice(1),
    }))
    .sort((a, b) => b.representative.score - a.representative.score);
}

/**
 * True when clustering collapsed at least two fires into one
 * bucket - i.e. the panel's "grouped by theme" view is hiding
 * some siblings behind cluster chips, and the "Show all" toggle
 * has something to reveal. The implementation reads as
 * "cluster count below fire count" but the meaning depends on
 * knowing how the cluster RPC works; the name carries the intent.
 */
export function isCollapsedView(
  clusters: readonly ClusterView[],
  fires: readonly SamskaraFireDiagnosticRow[]
): boolean {
  return clusters.length < fires.length;
}

/**
 * Three-state resolution label. The old four-way variant (in-flight
 * / window-open / aged-out) earned its keep in the diagnostics modal
 * where cohorts were a flat list with no message context; inline
 * under the user message that fired them, the transcript already
 * encodes "this turn fired N exchanges ago", so "pending" covers
 * every unresolved state.
 */
export function resolutionLabel(confirmed: boolean | null): string {
  if (confirmed === true) return 'confirmed';
  if (confirmed === false) return 'disconfirmed';
  return 'pending';
}

/**
 * Resolution flag to the CSS status-class key. Kept in sync with
 * `resolutionLabel`; the two return parallel arrays of the three
 * states.
 */
export function resolutionStatusClass(
  confirmed: boolean | null
): 'confirm' | 'disconfirm' | 'pending' {
  if (confirmed === true) return 'confirm';
  if (confirmed === false) return 'disconfirm';
  return 'pending';
}

/**
 * Substrate lifecycle label. Tracks how far the formation worker
 * has carried this row: situation+outcome filled by the
 * assimilator, embedding model filled by the embedder.
 */
export function assimilationStatus(
  row: SamskaraSubstrateDiagnosticRow
): string {
  if (row.situation === null) return 'pending assimilation';
  if (row.embeddingModel === null) return 'assimilated, pending embed';
  return 'assimilated + embedded';
}

/**
 * Substrate lifecycle to the CSS status-class key. Pairs with
 * `assimilationStatus` the same way `resolutionStatusClass` pairs
 * with `resolutionLabel`.
 */
export function substrateStatusClass(
  row: SamskaraSubstrateDiagnosticRow
): 'pending' | 'partial' | 'done' {
  if (row.situation === null) return 'pending';
  if (row.embeddingModel === null) return 'partial';
  return 'done';
}

/**
 * Relative-time formatter for the cohort header. `now` is injectable
 * so tests can pin a deterministic reference point; the production
 * caller leaves it defaulted to `Date.now()`.
 *
 * Returns 'never' for null/undefined, the original string for
 * unparseable input, and successively coarser units (s / m / h / d
 * / mo / y) so the head stays a single tight token.
 */
export function formatRelative(
  iso: string | null | undefined,
  now: number = Date.now()
): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = now - then;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.round(diffMo / 12);
  return `${diffYr}y ago`;
}

/**
 * Valence formatter. Renders the signed scalar with a forced `+`
 * for positive values and two-decimal precision; null becomes a
 * single hyphen so the head row stays aligned.
 */
export function formatValence(v: number | null): string {
  if (v === null) return '-';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}`;
}
