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
 * A `MoodShape` plus the monotonic id that keys the pill's fly
 * transition. This is the shape the shared `moodState.visual` carries
 * and the pills render; `SamskaraMoodSync.svelte` is its single writer.
 * Monotonic id (not Date.now()) so back-to-back mints in the same ms
 * still get distinct keys and the transition re-plays.
 */
export interface MoodVisual extends MoodShape {
  id: number;
}

/**
 * Triple the shared `moodState` rune stores. Returned by the
 * transition primitives so the component never has to construct
 * the shape itself - that rule (the store stores valence +
 * confidence + tier in this exact shape) belongs with the
 * decision logic, not the dispatch site.
 */
export interface MoodStoreUpdate {
  valence: number;
  confidence: number;
  tier: 1 | 2;
}

/**
 * Outcome of a mint event. `storeUpdate` is always present - the
 * shared store tracks every mint regardless of the local pill's
 * dedup decision (the diagnostics-modal dot reads the store
 * directly and should track raw mint events even when the local
 * pill skips its visual swap). `visual` is null when dedup
 * applies; non-null otherwise.
 */
export interface MintTransition {
  storeUpdate: MoodStoreUpdate;
  visual: MoodShape | null;
}

/**
 * Outcome of a seed-from-history apply. Mint's asymmetry (store
 * always, visual maybe) is absent here - both writes share the
 * same gate (placeholder still showing AND seed result non-null),
 * so the type wraps the apply-or-skip decision around the whole
 * thing as `SeedTransition | null` rather than carrying null in
 * either field.
 */
export interface SeedTransition {
  storeUpdate: MoodStoreUpdate;
  visual: MoodShape;
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
 * Outcome of a fresh mint event. `storeUpdate` is the unconditional
 * push into the shared mood store - it tracks every mint event
 * regardless of the local pill's dedup decision. `visual` carries
 * the dedup decision: null when the incoming mint lands in the
 * same emoji/label band as what is already showing AND the tier
 * hasn't changed, non-null otherwise.
 *
 * The dedup matters because every visual swap re-plays the fly
 * transition, which reads as visual noise when the model has been
 * steady-state for a few mints in a row. Tier is part of the
 * comparison because tier-2 carries a halo (`.mood-pill.tier-2`)
 * so a tier change IS visually meaningful even at the same
 * valence band.
 */
export function nextMoodFromMint(
  prev: MoodShape | null,
  detail: SamskaraMintEventDetail
): MintTransition {
  const storeUpdate: MoodStoreUpdate = {
    valence: detail.valence,
    confidence: detail.confidence,
    tier: detail.tier,
  };
  const emoji = valenceToEmoji(detail.valence, detail.confidence);
  const label = valenceToMoodLabel(detail.valence, detail.confidence);
  if (
    prev !== null &&
    prev.emoji === emoji &&
    prev.label === label &&
    prev.tier === detail.tier
  ) {
    return { storeUpdate, visual: null };
  }
  return {
    storeUpdate,
    visual: {
      emoji,
      label,
      tier: detail.tier,
      isDefault: false,
    },
  };
}

/**
 * Outcome of a seed-from-history fetch, or null when the seed
 * should not be applied. The null return path folds two distinct
 * reasons that share the same outcome (stay on the placeholder,
 * no writes anywhere):
 *
 *   - `seed === null` — the RPC returned no fires for this thread.
 *     Nothing to seed from; the U+1F4A4 placeholder is the right
 *     read for "we have no mood data."
 *   - `prev` is not the placeholder — a real mint won the within-
 *     thread race against this fetch and the seed must not clobber
 *     either the visual or the shared store.
 *
 * The component's per-thread generation counter handles the cross-
 * thread case (slow query for thread A versus fresh seed for
 * thread B); that gate stays at the call site because it depends
 * on the component's own lifecycle state.
 */
export function nextMoodFromSeed(
  prev: MoodShape | null,
  seed: MoodStoreUpdate | null
): SeedTransition | null {
  if (!seed) return null;
  if (!prev || !prev.isDefault) return null;
  return {
    storeUpdate: seed,
    visual: {
      emoji: valenceToEmoji(seed.valence, seed.confidence),
      label: valenceToMoodLabel(seed.valence, seed.confidence),
      tier: seed.tier,
      isDefault: false,
    },
  };
}
