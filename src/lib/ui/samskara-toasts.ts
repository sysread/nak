/**
 * UI-behavior primitives for the mood pill rendered by
 * `src/components/SamskaraToasts.svelte`. Pure functions only - no
 * runes, no Svelte imports, no DOM. The companion component owns
 * the framework-coupled bits (the `current` rune, the monotonic
 * `nextId` that keys the fly transition, the `$effect` that
 * reseeds on thread switch, the window event listener, and the
 * shared `moodState` side effects).
 *
 * `valenceToEmoji` / `valenceToMoodLabel` already live in
 * `src/lib/samskara/events.ts` (imported here for label/emoji
 * derivation) because they're shared with the worker bundle, which
 * cannot import Svelte runes. This module is one layer up - the
 * mood-shape transitions that the component would otherwise
 * inline.
 */
import {
  valenceToEmoji,
  valenceToMoodLabel,
  type SamskaraMintEventDetail,
} from '../samskara/events';

/**
 * U+1F4A4 SLEEPING SYMBOL. The "nothing has fired yet" placeholder.
 * Picked deliberately because it isn't in `valenceToEmoji`'s output
 * set - any real mint produces a different glyph, so the swap from
 * default to real mood is always visible.
 */
export const DEFAULT_EMOJI = '\u{1F4A4}';

/**
 * Tooltip / aria label that pairs with `DEFAULT_EMOJI`. Renders the
 * placeholder as "idle" so screen readers can tell "no mood data"
 * from a real reading instead of just hearing "samskara mood: idle"
 * with no further context.
 */
export const DEFAULT_LABEL = 'idle';

/**
 * Visual shape of the mood pill, minus the framework-specific id
 * the component slaps on top to key its transition.
 */
export interface MoodShape {
  emoji: string;
  label: string;
  tier: 1 | 2;
  /** True for the U+1F4A4 placeholder; flips false once a real
   *  mood lands (fresh mint OR seed-from-history upgrade). Drives
   *  the tooltip + aria-label so the disabled-looking state has a
   *  distinct reading from a real one. */
  isDefault: boolean;
}

/**
 * The placeholder shape shown on thread open before any mood has
 * landed. Tier 1 by default - the placeholder has no real tier;
 * the value only matters once a real mint replaces it.
 */
export function defaultMood(): MoodShape {
  return {
    emoji: DEFAULT_EMOJI,
    label: DEFAULT_LABEL,
    tier: 1,
    isDefault: true,
  };
}

/**
 * Next visual state after a fresh mint event, or null when the
 * pill should skip the visual swap because the incoming mint lands
 * in the same band as what's already showing AND the tier hasn't
 * changed.
 *
 * Without this dedup the fly transition replays on every mint -
 * reads as visual noise when the model has been steady-state for a
 * few mints in a row. Tier is part of the comparison because
 * tier-2 carries a halo (`.mood-pill.tier-2`) so a tier change IS
 * visually meaningful even at the same valence band.
 *
 * The shared `moodState` store update is the component's
 * responsibility and runs unconditionally; this function only
 * decides the local pill's visual transition.
 */
export function nextMoodFromMint(
  prev: MoodShape | null,
  detail: SamskaraMintEventDetail
): MoodShape | null {
  const emoji = valenceToEmoji(detail.valence, detail.confidence);
  const label = valenceToMoodLabel(detail.valence, detail.confidence);
  if (
    prev !== null &&
    prev.emoji === emoji &&
    prev.label === label &&
    prev.tier === detail.tier
  ) {
    return null;
  }
  return {
    emoji,
    label,
    tier: detail.tier,
    isDefault: false,
  };
}

/**
 * Next visual state after a seed-from-history fetch resolves, or
 * null when the placeholder is no longer showing - a real mint
 * landed during the in-flight fetch and the seed should be
 * discarded rather than clobber the live read.
 *
 * The component's per-thread generation counter handles the cross-
 * thread case (slow query for thread A versus fresh seed for
 * thread B); this function handles the within-thread case (slow
 * query versus a fresh mint that arrived first).
 */
export function nextMoodFromSeed(
  prev: MoodShape | null,
  seed: { valence: number; confidence: number; tier: 1 | 2 }
): MoodShape | null {
  if (!prev || !prev.isDefault) return null;
  return {
    emoji: valenceToEmoji(seed.valence, seed.confidence),
    label: valenceToMoodLabel(seed.valence, seed.confidence),
    tier: seed.tier,
    isDefault: false,
  };
}
