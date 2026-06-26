/**
 * Shared current-mood state, read by both the persistent mood pill
 * (top-right glance, `SamskaraToasts.svelte`) and the diagnostics
 * modal's legend overlay (`Samskara.svelte`'s "you are here" red
 * dot). Lifting the triple to a single Svelte 5 rune keeps the
 * modal's dot perfectly aligned with the pill the user clicked to
 * open it - no separate fetch, no listener race.
 *
 * Owned by SamskaraMoodSync.svelte (the single, headless data owner):
 * it writes `set` + `setVisual` from its `adopt` (mint event) and
 * `seedFromHistory` (latest fire on thread open) paths, and `clear`s
 * both when the active thread changes or there is no `cid` to scope a
 * mood to. Anything else that reads `current` / `visual` is a passive
 * observer.
 *
 * Two fields, two readers: `current` (valence/confidence/tier) feeds
 * the diagnostics-modal "you are here" dot; `visual` (emoji/label +
 * transition id) feeds the rendered mood pill in
 * `DiagnosticPills.svelte`, which is mounted twice (desktop + mobile)
 * and so must stay a pure reader - the heavy seed/mint logic lives in
 * the single sync owner, not the pill.
 *
 * Lives in its own .svelte.ts module rather than `events.ts`
 * because `events.ts` is deliberately rune-free (plain constants and
 * dispatch helpers, loadable from tests without a Svelte compile).
 * The pill / modal / any future consumer all sit on the main thread.
 */
import type { MoodVisual } from '$lib/ui/samskara-toasts';

export interface CurrentMood {
  /** [-1, 1], same scale used by `MOOD_TABLE.valenceMin`. */
  valence: number;
  /** [0, 1], split at `CONFIDENCE_CUT` into the confident/tentative columns. */
  confidence: number;
  /** Tier of the underlying samskara - reserved for visual variation
   *  (a halo on tier-2 cells, etc.) and carried through alongside the
   *  scalars so consumers don't have to re-fetch. */
  tier: 1 | 2;
}

let _current = $state<CurrentMood | null>(null);
let _visual = $state<MoodVisual | null>(null);

/**
 * Read the current mood, or null when there is no mood to show
 * (brand-new-chat screen, or a thread that has never fired and whose
 * seed query has not returned). Consumers should treat null as the
 * "no dot, no overlay" case.
 *
 * The setter accepts the full triple at once because the three
 * scalars are read together by every consumer (the dot's row is
 * picked from valence + tier and its column from confidence) and
 * splitting them into separate setters would invite a half-updated
 * intermediate render.
 */
export const moodState = {
  get current(): CurrentMood | null {
    return _current;
  },
  set(next: CurrentMood): void {
    _current = next;
  },
  /**
   * The rendered pill's visual shape (glyph/label + transition id), or
   * null when there's no thread to scope a mood to. Read by both
   * DiagnosticPills mounts; written only by SamskaraMoodSync.
   */
  get visual(): MoodVisual | null {
    return _visual;
  },
  setVisual(next: MoodVisual): void {
    _visual = next;
  },
  clear(): void {
    _current = null;
    _visual = null;
  },
};
