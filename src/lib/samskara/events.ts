/**
 * Rune-free side of the samskara main-thread event bridge. The event
 * name constant and the emoji mapping live here so the worker-adjacent
 * manager (which can't pull Svelte runes) can import them without
 * dragging a UI dependency into the worker bundle.
 *
 * The reactive toast UI is in `src/components/SamskaraToasts.svelte`
 * and listens for this event on `window`. Keep any `$state` /
 * `$derived` / `$effect` rune code OUT of this file.
 */

/**
 * Custom event name fired on `window` when a new samskara mints.
 * Detail shape: `SamskaraMintEventDetail`.
 */
export const SAMSKARA_MINT_EVENT = 'nak:samskara:mint';

export interface SamskaraMintEventDetail {
  /** Samskara tier (1 minted from substrate, 2 from tier-1 cohorts). */
  tier: 1 | 2;
  /**
   * Continuous scalar in [-1, 1]. Zero is neutral; positive is a
   * warm / satisfied predictive claim, negative is cool / friction.
   */
  valence: number;
  /**
   * Minter-self-reported confidence in the predictive claim, in
   * [0, 1]. Treated as a second axis on the mood pill: low confidence
   * pulls the glyph toward "uncertain" / "thoughtful" / "skeptical"
   * shapes that read differently from the corresponding high-confidence
   * cell, even when the valence band is the same.
   */
  confidence: number;
}

/**
 * Confidence cutpoint between "confident" and "tentative" rendering.
 * The minter returns confidence in [0, 1] (see MINTER_PROMPT). 0.5 is
 * the cleanest cut and matches the model's natural midpoint - claims
 * the model itself flags as below-average certainty get the second-
 * axis treatment.
 */
export const CONFIDENCE_CUT = 0.5;

/**
 * The full 2D mood table, in display order (rows = valence bands top
 * to bottom, columns = confident / tentative). Single source of truth
 * for both the band-lookup functions below and the legend rendered in
 * the Samskara diagnostics modal. Adding a row or shifting a glyph
 * here automatically flows through both consumers.
 *
 * Glyph collisions across cells (e.g. high-conf "content" and low-conf
 * "cheerful" both render as U+1F642) are intentional - the second axis
 * is carried by the tooltip label rather than by a unique glyph,
 * because the emoji vocabulary doesn't have clean low-confidence
 * companions for the warm side of the scale. Readers see the same
 * smile, but the tooltip distinguishes "content" from "tentatively
 * cheerful".
 */
export interface MoodCell {
  /** Inclusive lower bound on valence for this row. The top row's
   *  upper bound is +infinity so out-of-range +1.2 lands cleanly. */
  valenceMin: number;
  /** Glyph when confidence >= CONFIDENCE_CUT. */
  confidentEmoji: string;
  confidentLabel: string;
  /** Glyph when confidence < CONFIDENCE_CUT. */
  tentativeEmoji: string;
  tentativeLabel: string;
}

export const MOOD_TABLE: readonly MoodCell[] = [
  {
    valenceMin: 0.6,
    confidentEmoji: '\u{1F60A}', // smiling face with smiling eyes
    confidentLabel: 'cheerful',
    tentativeEmoji: '\u{1F642}', // slightly smiling face
    tentativeLabel: 'tentatively cheerful',
  },
  {
    valenceMin: 0.2,
    confidentEmoji: '\u{1F642}', // slightly smiling face
    confidentLabel: 'content',
    tentativeEmoji: '\u{1F914}', // thinking face
    tentativeLabel: 'thoughtful',
  },
  {
    valenceMin: -0.2,
    confidentEmoji: '\u{1F610}', // neutral face
    confidentLabel: 'neutral',
    tentativeEmoji: '\u{1F928}', // face with raised eyebrow
    tentativeLabel: 'skeptical',
  },
  {
    valenceMin: -0.6,
    confidentEmoji: '\u{1F615}', // confused face
    confidentLabel: 'uneasy',
    tentativeEmoji: '\u{1F62C}', // grimacing face
    tentativeLabel: 'wary',
  },
  {
    // Bottom row catches everything below -0.6 including out-of-range
    // -1.2; -Infinity makes the lookup branchless.
    valenceMin: -Infinity,
    confidentEmoji: '\u{1F614}', // pensive face
    confidentLabel: 'pensive',
    tentativeEmoji: '\u{1F625}', // sad but relieved face
    tentativeLabel: 'rueful',
  },
] as const;

/**
 * Find the index of the MOOD_TABLE row a valence falls into. Walks
 * top-down so the first matching `valenceMin` wins; the bottom row's
 * -Infinity means out-of-range negative values still land somewhere.
 *
 * The comparison is asymmetric on purpose: positive cuts (valenceMin
 * >= 0) are inclusive on the lower edge, so valence === 0.2 lands in
 * "content" rather than "neutral"; negative cuts (valenceMin < 0) are
 * strict, so valence === -0.2 lands in "uneasy" rather than "neutral".
 * Net effect: the neutral band is the open interval (-0.2, 0.2),
 * symmetric around zero - which is what the original 1D mapping
 * enforced and what the boundary tests pin. Keep the asymmetry; if
 * you want symmetric closure on both sides instead, every test
 * boundary needs to move with it.
 *
 * Returns the index rather than the row directly so consumers that
 * need to position something in the table grid (e.g. the diagnostics-
 * modal "you are here" dot) can walk by row index without a separate
 * indexOf hop.
 */
export function bandIndexFor(valence: number): number {
  for (let i = 0; i < MOOD_TABLE.length; i++) {
    const row = MOOD_TABLE[i];
    const inclusive = row.valenceMin >= 0;
    if (inclusive ? valence >= row.valenceMin : valence > row.valenceMin) {
      return i;
    }
  }
  // Unreachable - bottom row's valenceMin is -Infinity, and any real
  // number is strictly > -Infinity. The throw exists so TypeScript's
  // exhaustiveness check stays honest if someone reorders MOOD_TABLE
  // without keeping a -Infinity sentinel.
  throw new Error(`unreachable: no mood band for valence ${valence}`);
}

function bandFor(valence: number): MoodCell {
  return MOOD_TABLE[bandIndexFor(valence)];
}

/**
 * The two columns of MOOD_TABLE. `'confident'` is the high-confidence
 * column (confidence >= CONFIDENCE_CUT) and the default for callers
 * that don't pass confidence; `'tentative'` is the low-confidence
 * column. Carried as a string union rather than a 0/1 index so call
 * sites read self-documentingly and a typo is a compile error.
 */
export type MoodColumn = 'confident' | 'tentative';

export function columnFor(confidence: number): MoodColumn {
  return confidence < CONFIDENCE_CUT ? 'tentative' : 'confident';
}

/**
 * Combined cell coordinate for a (valence, confidence) pair. The
 * diagnostics-modal legend uses this to locate the matching <td> and
 * overlay the "you are here" dot; any other consumer wanting to
 * highlight a specific cell can use the same shape.
 */
export function cellFor(
  valence: number,
  confidence: number
): { row: number; column: MoodColumn } {
  return { row: bandIndexFor(valence), column: columnFor(confidence) };
}

/**
 * Map a samskara's (valence, confidence) pair to a single emoji glyph.
 * Five valence bands x two confidence bands = ten cells; see
 * MOOD_TABLE for the full grid. Confidence defaults to 1 so legacy
 * single-arg callers and the test suite continue to render the
 * confident column.
 *
 * Values outside [-1, 1] are clamped by the bucket logic rather than
 * by an explicit clamp() - we already trust the minter agent to stay
 * in range (it clamps there) and if something slips through, a rogue
 * +1.2 still lands in the top bucket.
 */
export function valenceToEmoji(valence: number, confidence: number = 1): string {
  const row = bandFor(valence);
  return confidence < CONFIDENCE_CUT ? row.tentativeEmoji : row.confidentEmoji;
}

/**
 * Short lowercase mood tag for the same (valence, confidence) bands as
 * valenceToEmoji. Surfaces in the mood pill's tooltip so the user can
 * tell at a glance what the emoji is trying to say without having to
 * decode the glyph itself - especially important on the tentative
 * column, where two cells can share a glyph but mean different things.
 * Same cutpoints as the emoji mapping so the two stay in lockstep;
 * adjust MOOD_TABLE to change them and both functions follow.
 */
export function valenceToMoodLabel(valence: number, confidence: number = 1): string {
  const row = bandFor(valence);
  return confidence < CONFIDENCE_CUT ? row.tentativeLabel : row.confidentLabel;
}

/**
 * Dispatch the mint event to the main thread's toast listener.
 * No-op when `window` is undefined — the samskara manager runs on the
 * main thread where `window` always exists in practice, but keeping
 * the guard means importing this file from a worker-adjacent module
 * (tests, SSR) never throws.
 */
export function notifySamskaraMint(detail: SamskaraMintEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<SamskaraMintEventDetail>(SAMSKARA_MINT_EVENT, { detail })
  );
}
