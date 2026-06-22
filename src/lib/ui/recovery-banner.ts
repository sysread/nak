/**
 * Single recovery-banner selector for the chat transcript tail.
 *
 * The tail can satisfy several "this turn did not finish, want to retry?"
 * conditions at once. A session that died with a persisted user row AND a
 * leftover IndexedDB streaming draft trips both the generic cut-off tail
 * (`incompleteTurnTail`) and the orphaned-draft recovery
 * (`interruptedDraft`) - and an explained error (`displayedError`) is a
 * third, parallel surface. Rendered independently these stack as two or
 * three near-identical retry boxes.
 *
 * This module collapses them to one: the component binds each source's
 * retry/dismiss closures and `selectRecoveryBanner` picks the single
 * winner by precedence - a discrete error (red alert) outranks a
 * recoverable interrupted draft, which outranks a generic cut-off tail.
 * Precedence + display copy live here because they are framework-agnostic
 * decision logic; a port to React/Vue would reuse this verbatim. The
 * `.svelte` file owns only the markup and the runes that feed it.
 *
 * Interacts with: src/screens/Chat.svelte (the `recoveryBanner` derived +
 * the single banner template), src/lib/ui/incomplete-turn.ts and
 * src/lib/ui/last-error.ts (the sources that feed it).
 */

/** The cut-off tail and a recovered draft share the muted note styling
 *  ('incomplete'); an explained error gets the danger-tinted alert
 *  styling ('error'). The variant drives which CSS class family the
 *  banner renders with. */
export type RecoveryBannerVariant = 'error' | 'incomplete';

export interface RecoveryBanner {
  variant: RecoveryBannerVariant;
  /** Optional kind-label, only the error variant carries one. */
  heading?: string;
  text: string;
  /** Present only when the underlying state is retryable. */
  retry?: () => void;
  /** Present only when the source offers a discard (error cards and the
   *  recoverable draft, never the generic cut-off tail). */
  dismiss?: () => void;
}

export const CUT_OFF_BANNER_TEXT =
  'The response appears to have been cut off. Click to retry.';
export const INTERRUPTED_BANNER_TEXT =
  'Previous response was interrupted. Retry to generate a new one.';

export interface RecoveryBannerSources {
  /** Mirrors Chat.svelte's `displayedError` descriptor. Highest
   *  precedence: an explained failure is the most actionable signal. */
  error: {
    heading?: string;
    text: string;
    retry?: () => void;
    dismiss: () => void;
  } | null;
  /** A recoverable orphaned draft (IndexedDB streaming buffer with no
   *  committed assistant reply). Richer than the cut-off tail because the
   *  draft text is the fuel for the re-run and the user can discard it. */
  interruptedDraft: { retry: () => void; dismiss: () => void } | null;
  /** A generic orphan tail with no explained cause and no recoverable
   *  draft - the lowest-precedence "offer a retry" fallback. */
  cutOff: { retry: () => void } | null;
}

/**
 * Pick the single recovery banner to render, or null when the tail is
 * healthy. Precedence: error > interrupted-draft > cut-off. The caller
 * is responsible for gating each source (e.g. suppressing the recovery
 * variants while a foreign device holds a live claim) before passing it
 * in; this function only resolves the overlap.
 */
export function selectRecoveryBanner(
  sources: RecoveryBannerSources,
): RecoveryBanner | null {
  const { error, interruptedDraft, cutOff } = sources;
  if (error) {
    return {
      variant: 'error',
      heading: error.heading,
      text: error.text,
      retry: error.retry,
      dismiss: error.dismiss,
    };
  }
  if (interruptedDraft) {
    return {
      variant: 'incomplete',
      text: INTERRUPTED_BANNER_TEXT,
      retry: interruptedDraft.retry,
      dismiss: interruptedDraft.dismiss,
    };
  }
  if (cutOff) {
    return {
      variant: 'incomplete',
      text: CUT_OFF_BANNER_TEXT,
      retry: cutOff.retry,
    };
  }
  return null;
}
