/**
 * Stable drive identifiers for the intuition feature.
 *
 * The subconscious-layer prompts (perception, the five drive prompts,
 * synthesis) that used to live here run server-side now - pre-turn
 * priming moved into the venice edge function. What the browser still
 * needs is the drive name set: the Intuition modal lays out one slot
 * per drive, and the cached payload keys its `drives` map by these
 * names.
 */

/**
 * Stable identifier for each drive. Used as keys in the cached
 * payload's `drives` map. Reorder/rename here is a wire change -
 * existing cache payloads will look like they're missing keys (the
 * cache treats a missing key the same as "no reaction this round"
 * rather than crashing, but the modal will render a blank slot).
 */
export type DriveName =
  | 'attunement'
  | 'candor'
  | 'curiosity'
  | 'pragmatism'
  | 'standing';

export const DRIVE_NAMES: readonly DriveName[] = [
  'attunement',
  'candor',
  'curiosity',
  'pragmatism',
  'standing',
] as const;
