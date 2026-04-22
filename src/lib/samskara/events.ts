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
}

/**
 * Map a samskara's valence to a single emoji glyph. Five bands at
 * 0.3-wide buckets so the extremes read clearly without overshooting
 * into caricature — 😊 at strongly positive, 😔 at strongly negative,
 * 😐 at neutral, and two softer steps either side for the common case.
 *
 * Values outside [-1, 1] are clamped by the bucket logic rather than
 * by an explicit clamp() - we already trust the minter agent to stay
 * in range (it clamps there) and if something slips through, a rogue
 * +1.2 still lands in the top bucket.
 */
export function valenceToEmoji(valence: number): string {
  if (valence >= 0.6) return '\u{1F60A}'; // smiling face with smiling eyes
  if (valence >= 0.2) return '\u{1F642}'; // slightly smiling face
  if (valence > -0.2) return '\u{1F610}'; // neutral face
  if (valence > -0.6) return '\u{1F615}'; // confused face (soft frown)
  return '\u{1F614}'; // pensive face
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
