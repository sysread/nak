/**
 * Pure-logic coverage for the intuition trigger evaluators. Verifies
 * the same-round debounce, mood-shift detection, stale-fuse, and
 * cold-start posture without spinning up Venice, Supabase, or any
 * Svelte runtime.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluatePreRoundTrigger,
  evaluateTitleTrigger,
  countUserRounds,
  STALE_FUSE_ROUNDS,
  type IntuitionPayload,
} from '../src/lib/intuition';

function payload(overrides: Partial<IntuitionPayload> = {}): IntuitionPayload {
  return {
    v: 1,
    perception: 'Classification: chitchat\n\nThe user said hi.',
    drives: { attunement: 'be warm', candor: 'be honest' },
    synthesis: 'Match the casual register.',
    computed_at_round: 1,
    computed_at_band: 2, // neutral
    computed_at_column: 'confident',
    computed_at_at: 1_700_000_000_000,
    trigger: 'cold',
    ...overrides,
  };
}

describe('countUserRounds', () => {
  it('counts user messages and ignores everything else', () => {
    expect(
      countUserRounds([
        { role: 'system' },
        { role: 'user' },
        { role: 'assistant' },
        { role: 'tool' },
        { role: 'user' },
        { role: 'assistant' },
      ])
    ).toBe(2);
  });

  it('returns zero on an empty history', () => {
    expect(countUserRounds([])).toBe(0);
  });

  it('counts tool-using turns as one user round, not many', () => {
    // A single user message can spawn multiple chat-loop rounds via
    // tool calls. The user-round count should still be 1.
    expect(
      countUserRounds([
        { role: 'user' },
        { role: 'assistant' }, // tool_calls
        { role: 'tool' },
        { role: 'tool' },
        { role: 'assistant' }, // tool_calls again
        { role: 'tool' },
        { role: 'assistant' }, // final answer
      ])
    ).toBe(1);
  });
});

describe('evaluatePreRoundTrigger', () => {
  it('returns "cold" on cold start (no cache) so turn 1 always fires', () => {
    // Earlier behaviour returned null here, deferring to the title
    // trigger to populate the cache. That left the feature invisible
    // on any thread where the model didn't call update_title (manually-
    // titled threads, threads created before the feature shipped, or
    // a model that simply skipped the rename) - so the trigger now
    // fires unconditionally on cold cache.
    expect(
      evaluatePreRoundTrigger({
        cache: null,
        round: 1,
        mood: { band: 2, column: 'confident' },
      })
    ).toBe('cold');
  });

  it('returns "cold" on cold start even when mood is null', () => {
    expect(
      evaluatePreRoundTrigger({
        cache: null,
        round: 1,
        mood: null,
      })
    ).toBe('cold');
  });

  it('debounces when cache was written this round already', () => {
    expect(
      evaluatePreRoundTrigger({
        cache: payload({ computed_at_round: 3 }),
        round: 3,
        mood: { band: 2, column: 'confident' },
      })
    ).toBeNull();
  });

  it('debounces when cache is from a future round (paranoid edge)', () => {
    // Shouldn't happen in practice, but if a stored round id is
    // somehow >= current round we still want to no-op rather than
    // double-fire.
    expect(
      evaluatePreRoundTrigger({
        cache: payload({ computed_at_round: 5 }),
        round: 3,
        mood: { band: 2, column: 'confident' },
      })
    ).toBeNull();
  });

  it('fires "mood" when valence band changed since cache was written', () => {
    expect(
      evaluatePreRoundTrigger({
        cache: payload({ computed_at_round: 1, computed_at_band: 0 }),
        round: 2,
        mood: { band: 3, column: 'confident' },
      })
    ).toBe('mood');
  });

  it('fires "mood" when only the confidence column flipped', () => {
    expect(
      evaluatePreRoundTrigger({
        cache: payload({
          computed_at_round: 1,
          computed_at_band: 2,
          computed_at_column: 'confident',
        }),
        round: 2,
        mood: { band: 2, column: 'tentative' },
      })
    ).toBe('mood');
  });

  it('does not fire "mood" when neither band nor column changed', () => {
    // Bands match and columns match - no shift to react to. The
    // stale-fuse below is the only fall-through trigger.
    expect(
      evaluatePreRoundTrigger({
        cache: payload({
          computed_at_round: 2,
          computed_at_band: 2,
          computed_at_column: 'confident',
        }),
        round: 3,
        mood: { band: 2, column: 'confident' },
      })
    ).toBeNull();
  });

  it('skips mood comparison when live mood is null', () => {
    // Cold mood (thread never fired) shouldn't trigger refresh - we
    // can't tell "still neutral" from "no signal yet".
    expect(
      evaluatePreRoundTrigger({
        cache: payload({ computed_at_round: 2 }),
        round: 3,
        mood: null,
      })
    ).toBeNull();
  });

  it('fires "stale" once enough rounds have passed without a refresh', () => {
    expect(
      evaluatePreRoundTrigger({
        cache: payload({
          computed_at_round: 1,
          computed_at_band: 2,
          computed_at_column: 'confident',
        }),
        round: 1 + STALE_FUSE_ROUNDS,
        mood: { band: 2, column: 'confident' },
      })
    ).toBe('stale');
  });

  it('fires "mood" not "stale" when both conditions are met simultaneously', () => {
    // Mood-shift takes precedence; the trigger reason logged on the
    // payload should reflect the actual cause, not the first fall-
    // through.
    expect(
      evaluatePreRoundTrigger({
        cache: payload({
          computed_at_round: 1,
          computed_at_band: 0,
        }),
        round: 1 + STALE_FUSE_ROUNDS,
        mood: { band: 4, column: 'tentative' },
      })
    ).toBe('mood');
  });
});

describe('evaluateTitleTrigger', () => {
  it('returns "cold" on first turn with no cache', () => {
    expect(
      evaluateTitleTrigger({
        cache: null,
        round: 1,
        mood: null,
      })
    ).toBe('cold');
  });

  it('returns "title" when cache exists and is from a different round', () => {
    expect(
      evaluateTitleTrigger({
        cache: payload({ computed_at_round: 1 }),
        round: 3,
        mood: { band: 2, column: 'confident' },
      })
    ).toBe('title');
  });

  it('debounces when cache was already written this round', () => {
    // Pre-round trigger fired earlier this same turn. The title
    // trigger should not run a second pipeline.
    expect(
      evaluateTitleTrigger({
        cache: payload({ computed_at_round: 3 }),
        round: 3,
        mood: null,
      })
    ).toBeNull();
  });
});
