/**
 * Samskara-domain row types: the Corpus browse/search projections, the
 * diagnostics rows behind the inline CohortPanel, and the Health
 * panel's snapshot/rates/verdict shapes. Query wrappers that produce
 * these live in `../samskara.ts`. Re-exported through `../../supabase.ts`
 * so consumers keep importing from `$lib/supabase`.
 */

/** Sort keys for the Corpus browse list. */
export type SamskaraBrowseSort = 'recent' | 'strongest' | 'most_fired' | 'recently_fired';

/**
 * A samskara as rendered in the Corpus panel's list and detail views.
 * camelCased at the boundary so the UI never sees snake_case. `cosine`
 * is present only on search results (the browse list omits it). No
 * embedding - too fat for a list.
 */
export interface SamskaraCorpusRow {
  id: string;
  tier: number;
  prediction: string;
  innerVoice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
  fireCount: number;
  confirmCount: number;
  disconfirmCount: number;
  lastFiredAt: string | null;
  createdAt: string;
  cosine?: number;
}

/** One labelled provenance edge of a samskara, for the detail view. */
export interface SamskaraProvenanceRow {
  kind: 'substrate' | 'association' | 'samskara';
  refId: string;
  weight: number;
  /** Resolved label (child prediction / situation / relation), or null if the target was deleted. */
  label: string | null;
  /** Tier of the referenced samskara, present only for kind='samskara'. */
  refTier: number | null;
}

/** Corpus-wide live health snapshot for the Health panel. */
export interface SamskaraHealthSnapshot {
  totalSamskaras: number;
  tier1: number;
  tier2: number;
  nearDead: number;
  neverFired: number;
  associations: number;
  /** Association edges not yet fed to the association-mint pass. Drains across sweeps. */
  associationsUnconsumed: number;
  substrateTotal: number;
  pendingAssimilate: number;
  pendingEmbed: number;
  firesTotal: number;
  firesAwaitingJudgment: number;
  orphanFires: number;
  stuckAssimilateClaims: number;
  stuckEmbedClaims: number;
}

/** Windowed activity rates for the Health panel. */
export interface SamskaraRates {
  windowDays: number;
  mints: number;
  fires: number;
  resolved: number;
  unresolved: number;
  resolutionPct: number;
  held: number;
  contradicted: number;
  notBorneOut: number;
  notEngaged: number;
}

/** Lifetime per-samskara verdict counts (raw fire counts, not the
 *  discounted posterior tallies). `pending` = fired but unjudged. */
export interface SamskaraVerdictCounts {
  held: number;
  contradicted: number;
  notBorneOut: number;
  notEngaged: number;
  pending: number;
}

/**
 * Substrate row as shown in the diagnostics screen. Excludes the
 * embedding vector (too fat for a human-readable panel) and renames
 * to camelCase at the boundary so the component doesn't ship snake-
 * case identifiers into the UI.
 */
export interface SamskaraSubstrateDiagnosticRow {
  id: string;
  userMessageId: string;
  assistantMessageId: string | null;
  situation: string | null;
  outcome: string | null;
  valence: number | null;
  /** Set once the embedding has landed; also a de-facto "embedded?" flag. */
  embeddingModel: string | null;
  createdAt: string;
}

/**
 * Fire row with its joined samskara payload, for diagnostics
 * rendering. Grouping by `cohortId` is the renderer's job - the DB
 * query returns one row per (cohort_id, samskara_id) pair.
 */
export interface SamskaraFireDiagnosticRow {
  id: string;
  cohortId: string;
  samskaraId: string;
  score: number;
  firedAt: string;
  wasConfirmed: boolean | null;
  /** The next-day judge's verdict for this fire: 'held' / 'contradicted'
   *  / 'not-borne-out' / 'not-engaged', or null until judged. Carries the
   *  soft-miss distinction that wasConfirmed (a boolean) collapses - the
   *  cohort panel renders it per fire. */
  verdict: string | null;
  /** 1-based index of the user message that triggered this cohort, as
   *  counted by the chat loop at fire time. Null for legacy rows
   *  written before the column existed and not yet covered by the
   *  one-time backfill - the per-message inline UI suppresses the
   *  toggle on user messages where no cohort maps to this round. */
  userRound: number | null;
  /** Null only when the samskara was deleted after the fire logged;
   *  the row keeps pointing to the now-orphaned id. */
  samskara: {
    tier: number;
    prediction: string;
    innerVoice: string | null;
    valence: number | null;
    confidence: number;
    health: number;
  } | null;
}
