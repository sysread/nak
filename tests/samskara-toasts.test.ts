/**
 * Unit coverage for the mood-pill UI primitives. Pure functions -
 * no runes, no DOM, no reactive state - tested via plain vitest.
 *
 * The companion `src/components/SamskaraToasts.svelte` is the only
 * caller that wires these into Svelte reactivity (the `current`
 * rune, the monotonic `nextId` that keys the fly transition, the
 * `$effect` that reseeds on thread switch, the window event
 * listener, and the shared `moodState` side effects). A port to
 * another framework would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import type { SamskaraMintEventDetail } from '../src/lib/samskara/events';
import {
  DEFAULT_EMOJI,
  DEFAULT_LABEL,
  defaultMood,
  nextMoodFromMint,
  nextMoodFromSeed,
  type MoodShape,
} from '../src/lib/ui/samskara-toasts';

function mint(
  valence: number,
  confidence: number,
  tier: 1 | 2 = 1
): SamskaraMintEventDetail {
  // The other fields on SamskaraMintEventDetail (samskaraId, etc.)
  // aren't read by the primitives under test - the structural cast
  // keeps the fixture tight.
  return { valence, confidence, tier } as SamskaraMintEventDetail;
}

describe('defaultMood', () => {
  it('produces the U+1F4A4 placeholder shape', () => {
    expect(defaultMood()).toEqual({
      emoji: DEFAULT_EMOJI,
      label: DEFAULT_LABEL,
      tier: 1,
      isDefault: true,
    });
  });

  it('returns a fresh object every call so the caller can mutate freely', () => {
    const a = defaultMood();
    const b = defaultMood();
    expect(a).not.toBe(b);
  });

  it('renders the sleeping symbol, not a real mint emoji', () => {
    // Sanity check that the placeholder is outside the live emoji
    // set so the swap from default to real is always visually
    // distinct.
    expect(defaultMood().emoji).toBe('\u{1F4A4}');
  });
});

describe('nextMoodFromMint', () => {
  it('returns a new shape when there is no prior mood', () => {
    const next = nextMoodFromMint(null, mint(0.6, 0.9));
    expect(next).not.toBeNull();
    expect(next?.isDefault).toBe(false);
    expect(next?.tier).toBe(1);
    expect(next?.emoji).toBeTruthy();
    expect(next?.label).toBeTruthy();
  });

  it('replaces the default placeholder with a real mood', () => {
    const next = nextMoodFromMint(defaultMood(), mint(0.6, 0.9));
    expect(next).not.toBeNull();
    expect(next?.isDefault).toBe(false);
    expect(next?.emoji).not.toBe(DEFAULT_EMOJI);
  });

  it('returns null when the incoming mint lands in the same band', () => {
    // Two mints in the same valence/confidence neighbourhood
    // should produce identical emoji + label + tier - the dedup
    // skips the visual swap so the fly transition does not
    // re-play.
    const first = nextMoodFromMint(null, mint(0.6, 0.9));
    expect(first).not.toBeNull();
    const prev: MoodShape = first as MoodShape;
    const second = nextMoodFromMint(prev, mint(0.62, 0.91));
    expect(second).toBeNull();
  });

  it('returns a new shape when valence band changes', () => {
    const prev = nextMoodFromMint(null, mint(0.6, 0.9)) as MoodShape;
    const next = nextMoodFromMint(prev, mint(-0.6, 0.9));
    expect(next).not.toBeNull();
    expect(next?.emoji).not.toBe(prev.emoji);
  });

  it('returns a new shape when tier changes even at the same valence', () => {
    // Tier-2 carries a halo so the visual treatment differs from
    // tier-1 at the same valence band. Dedup must NOT skip in
    // that case.
    const prev = nextMoodFromMint(null, mint(0.6, 0.9, 1)) as MoodShape;
    const next = nextMoodFromMint(prev, mint(0.6, 0.9, 2));
    expect(next).not.toBeNull();
    expect(next?.tier).toBe(2);
  });
});

describe('nextMoodFromSeed', () => {
  it('upgrades the default placeholder with the seed result', () => {
    const next = nextMoodFromSeed(defaultMood(), {
      valence: 0.6,
      confidence: 0.9,
      tier: 1,
    });
    expect(next).not.toBeNull();
    expect(next?.isDefault).toBe(false);
    expect(next?.emoji).not.toBe(DEFAULT_EMOJI);
  });

  it('returns null when no prior mood is showing', () => {
    // The pill is suppressed entirely (route.cid === null
    // brand-new-chat case); a seed result must not materialise a
    // mood out of nowhere.
    expect(
      nextMoodFromSeed(null, { valence: 0.6, confidence: 0.9, tier: 1 })
    ).toBeNull();
  });

  it('returns null when a real mint won the race (current is no longer default)', () => {
    // The within-thread race: seed query is in flight; a fresh
    // mint event lands first and replaces the placeholder; the
    // seed result must not clobber it.
    const realMint = nextMoodFromMint(
      defaultMood(),
      mint(0.6, 0.9)
    ) as MoodShape;
    expect(realMint.isDefault).toBe(false);
    const next = nextMoodFromSeed(realMint, {
      valence: -0.3,
      confidence: 0.5,
      tier: 1,
    });
    expect(next).toBeNull();
  });

  it('preserves the seed tier on the upgraded shape', () => {
    const next = nextMoodFromSeed(defaultMood(), {
      valence: 0.6,
      confidence: 0.9,
      tier: 2,
    });
    expect(next?.tier).toBe(2);
  });
});
