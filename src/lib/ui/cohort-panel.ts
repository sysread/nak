/**
 * UI-behavior primitives for the cohort diagnostic panel mounted
 * inline under each user message in the chat transcript. Pure
 * functions only - no runes, no Svelte imports, no DOM access. The
 * companion `src/components/CohortPanel.svelte` composes these with
 * its own runes (`raw`, `expandedClusters`) and renders the result;
 * `src/screens/Chat.svelte` uses the transcript-anchoring walks at
 * the bottom of this module to decide which user messages get the
 * inline panel toggle.
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
  Message,
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
 * Header count summary. Grouped view (clustering collapsed at least
 * one bucket AND the user hasn't toggled "Show all") leads with the
 * theme count so the header explains why fewer rows render than
 * fires exist; otherwise the plain fire count.
 */
export function cohortCountLabel(
  clusterCount: number,
  fireCount: number,
  grouped: boolean
): string {
  const fires = `${fireCount} prediction${fireCount === 1 ? '' : 's'}`;
  if (!grouped) return fires;
  return `${clusterCount} theme${clusterCount === 1 ? '' : 's'} from ${fires}`;
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
 * Per-fire verdict label for the cohort panel. Unlike resolutionLabel
 * (which reads the three-state was_confirmed boolean and so cannot tell
 * a soft miss from a hard one), this reads the judge's verdict string
 * and keeps not-borne-out distinct from contradicted. Fires in one
 * cohort can carry different verdicts - the judge rules per samskara -
 * so this renders per fire, not per cohort. Null = fired, not yet judged.
 */
export function fireVerdictLabel(verdict: string | null): string {
  switch (verdict) {
    case 'held':
      return 'held';
    case 'contradicted':
      return 'contradicted';
    case 'not-borne-out':
      return 'not borne out';
    case 'not-engaged':
      return 'not engaged';
    default:
      return 'pending';
  }
}

/**
 * Verdict to status-class key, parallel to fireVerdictLabel. not-borne-out
 * gets its own 'partial' bucket (a soft miss, visually amber) so it reads
 * as distinct from the hard-red contradicted; not-engaged is 'neutral'
 * (no fair test); null is 'pending'.
 */
export function fireVerdictStatusClass(
  verdict: string | null
): 'confirm' | 'disconfirm' | 'partial' | 'neutral' | 'pending' {
  switch (verdict) {
    case 'held':
      return 'confirm';
    case 'contradicted':
      return 'disconfirm';
    case 'not-borne-out':
      return 'partial';
    case 'not-engaged':
      return 'neutral';
    default:
      return 'pending';
  }
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

export function formatScore(v: number): string {
  return v.toFixed(3);
}

export function formatConfidence(v: number): string {
  return v.toFixed(2);
}

export function formatHealth(v: number): string {
  return v.toFixed(2);
}

/**
 * Walk messages in transcript order and assign 1..N to user
 * messages. Matches the runtime countUserRounds() the chat loop
 * calls at fire time: both count current user messages, both stop
 * at the same boundary, so the index produced here is the same
 * value persisted on samskara_fires.user_round at fire time. Tool
 * and assistant rows do not advance the counter.
 *
 * The inverse walk (round number -> user Message) lives in
 * src/lib/ui/recall.ts as buildUserMessageByRound; this direction
 * anchors the inline cohort toggle to each user message's row.
 */
export function buildUserRoundByMessageId(
  messages: readonly Message[]
): Map<string, number> {
  const map = new Map<string, number>();
  let n = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      n += 1;
      map.set(m.id, n);
    }
  }
  return map;
}

/**
 * Group fires by their persisted user_round. Legacy rows whose
 * backfill didn't produce a value (the column was NULL and the
 * approximate ranking couldn't reach them - shouldn't happen but
 * guard anyway) are dropped from the inline view rather than
 * anchored at an arbitrary message.
 */
export function groupFiresByUserRound(
  fires: readonly SamskaraFireDiagnosticRow[]
): Map<number, SamskaraFireDiagnosticRow[]> {
  const map = new Map<number, SamskaraFireDiagnosticRow[]>();
  for (const f of fires) {
    if (f.userRound === null) continue;
    const bucket = map.get(f.userRound);
    if (bucket) bucket.push(f);
    else map.set(f.userRound, [f]);
  }
  return map;
}
