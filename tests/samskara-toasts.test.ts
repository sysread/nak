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
  describe('storeUpdate (unconditional)', () => {
    it('always carries the raw triple from the mint detail', () => {
      // No prior mood; visual will materialise, but the contract
      // here is that storeUpdate is identical whether or not the
      // dedup path takes the visual.
      const out = nextMoodFromMint(null, mint(0.6, 0.9, 2));
      expect(out.storeUpdate).toEqual({
        valence: 0.6,
        confidence: 0.9,
        tier: 2,
      });
    });

    it('still carries the triple when the visual is dedup-skipped', () => {
      // The diagnostics-modal dot reads the shared store directly,
      // so it must track every mint event even when the local
      // pill skips its visual swap.
      const first = nextMoodFromMint(null, mint(0.6, 0.9));
      const prev = first.visual as MoodShape;
      const second = nextMoodFromMint(prev, mint(0.62, 0.91));
      expect(second.visual).toBeNull();
      expect(second.storeUpdate).toEqual({
        valence: 0.62,
        confidence: 0.91,
        tier: 1,
      });
    });
  });

  describe('visual (dedup decision)', () => {
    it('materialises a new shape when there is no prior mood', () => {
      const out = nextMoodFromMint(null, mint(0.6, 0.9));
      expect(out.visual).not.toBeNull();
      expect(out.visual?.isDefault).toBe(false);
      expect(out.visual?.tier).toBe(1);
    });

    it('replaces the default placeholder with a real mood', () => {
      const out = nextMoodFromMint(defaultMood(), mint(0.6, 0.9));
      expect(out.visual).not.toBeNull();
      expect(out.visual?.isDefault).toBe(false);
      expect(out.visual?.emoji).not.toBe(DEFAULT_EMOJI);
    });

    it('is null when the incoming mint lands in the same band', () => {
      // Two mints in the same valence/confidence neighbourhood
      // should produce identical emoji + label + tier - the dedup
      // skips the visual swap so the fly transition does not
      // re-play.
      const first = nextMoodFromMint(null, mint(0.6, 0.9));
      const prev = first.visual as MoodShape;
      const second = nextMoodFromMint(prev, mint(0.62, 0.91));
      expect(second.visual).toBeNull();
    });

    it('materialises a new shape when valence band changes', () => {
      const prev = nextMoodFromMint(null, mint(0.6, 0.9)).visual as MoodShape;
      const out = nextMoodFromMint(prev, mint(-0.6, 0.9));
      expect(out.visual).not.toBeNull();
      expect(out.visual?.emoji).not.toBe(prev.emoji);
    });

    it('materialises a new shape when tier changes even at the same valence', () => {
      // Tier-2 carries a halo so the visual treatment differs from
      // tier-1 at the same valence band. Dedup must NOT skip in
      // that case.
      const prev = nextMoodFromMint(null, mint(0.6, 0.9, 1)).visual as MoodShape;
      const out = nextMoodFromMint(prev, mint(0.6, 0.9, 2));
      expect(out.visual).not.toBeNull();
      expect(out.visual?.tier).toBe(2);
    });
  });
});

describe('nextMoodFromSeed', () => {
  it('returns a paired storeUpdate + visual when upgrading from the placeholder', () => {
    const out = nextMoodFromSeed(defaultMood(), {
      valence: 0.6,
      confidence: 0.9,
      tier: 1,
    });
    expect(out).not.toBeNull();
    expect(out?.storeUpdate).toEqual({
      valence: 0.6,
      confidence: 0.9,
      tier: 1,
    });
    expect(out?.visual.isDefault).toBe(false);
    expect(out?.visual.emoji).not.toBe(DEFAULT_EMOJI);
  });

  it('returns null when the RPC returned no fires for this thread', () => {
    // The "nothing to seed from" decision lives in the primitive
    // so the component does not have to type-narrow result twice
    // after the primitive call. Stays on the placeholder.
    expect(nextMoodFromSeed(defaultMood(), null)).toBeNull();
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
    // seed result must not clobber either the visual or the
    // shared store.
    const realMint = nextMoodFromMint(defaultMood(), mint(0.6, 0.9))
      .visual as MoodShape;
    expect(realMint.isDefault).toBe(false);
    const out = nextMoodFromSeed(realMint, {
      valence: -0.3,
      confidence: 0.5,
      tier: 1,
    });
    expect(out).toBeNull();
  });

  it('preserves the seed tier on both visual and storeUpdate', () => {
    const out = nextMoodFromSeed(defaultMood(), {
      valence: 0.6,
      confidence: 0.9,
      tier: 2,
    });
    expect(out?.visual.tier).toBe(2);
    expect(out?.storeUpdate.tier).toBe(2);
  });
});
