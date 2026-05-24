/**
 * Display copy for the transient "oops, all slop!" notice cards
 * (src/lib/exchange/exchange-slot.svelte.ts `SlopNotice`). The card is
 * shown when an output guard discards a junk streaming attempt and
 * re-rolls; this module maps the tripping guard's name to the headline
 * and sub-line the card renders.
 *
 * Lives here, not inline in Chat.svelte, because a guard-name-to-copy
 * map is a framework-agnostic transform - a port to React/Vue would
 * reuse it verbatim. The component just calls `slopNoticeCopy(guard)`.
 */

export interface SlopNoticeCopy {
  /** Playful headline. */
  headline: string;
  /** One-line explanation of what was discarded and that a retry is underway. */
  detail: string;
}

const GUARD_COPY: Record<string, SlopNoticeCopy> = {
  'special-token-leak': {
    headline: 'oops, all slop!',
    detail: 'The model leaked a glitch token instead of answering. Regenerating...',
  },
};

const FALLBACK_COPY: SlopNoticeCopy = {
  headline: 'oops, all slop!',
  detail: 'That response came back malformed. Regenerating...',
};

/**
 * Copy for a slop-notice card, keyed by the guard that tripped. Unknown
 * guard names fall back to generic copy so a future guard that forgets
 * to register still renders something sensible.
 */
export function slopNoticeCopy(guard: string): SlopNoticeCopy {
  return GUARD_COPY[guard] ?? FALLBACK_COPY;
}
