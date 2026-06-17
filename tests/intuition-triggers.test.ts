/**
 * Pure-logic coverage for the intuition trigger evaluators. Verifies
 * the same-round debounce, mood-shift detection, stale-fuse, and
 * cold-start posture without spinning up Venice, Supabase, or any
 * Svelte runtime.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluatePreRoundTrigger,
  isPayloadFreshForInjection,
  countUserRounds,
  STALE_FUSE_ROUNDS,
  STALE_FUSE_MS,
  type IntuitionPayload,
} from '../src/lib/intuition';

// Fixed "now" that matches the payload helper's computed_at_at, so the
// wall-clock fuse reads zero elapsed unless a case deliberately
// advances nowMs. Lets the round/mood/debounce cases isolate their own
// trigger without the wall-clock fuse firing underneath them.
const NOW = 1_700_000_000_000;

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
        nowMs: NOW,
      })
    ).toBe('cold');
  });

  it('returns "cold" on cold start even when mood is null', () => {
    expect(
      evaluatePreRoundTrigger({
        cache: null,
        round: 1,
        mood: null,
        nowMs: NOW,
      })
    ).toBe('cold');
  });

  it('debounces when cache was written this round already', () => {
    expect(
      evaluatePreRoundTrigger({
        cache: payload({ computed_at_round: 3 }),
        round: 3,
        mood: { band: 2, column: 'confident' },
        nowMs: NOW,
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
        nowMs: NOW,
      })
    ).toBeNull();
  });

  it('fires "mood" when valence band changed since cache was written', () => {
    expect(
      evaluatePreRoundTrigger({
        cache: payload({ computed_at_round: 1, computed_at_band: 0 }),
        round: 2,
        mood: { band: 3, column: 'confident' },
        nowMs: NOW,
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
        nowMs: NOW,
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
        nowMs: NOW,
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
        nowMs: NOW,
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
        nowMs: NOW,
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
        nowMs: NOW,
      })
    ).toBe('mood');
  });

  it('fires "stale" on the wall-clock fuse even when rounds and mood held', () => {
    // The bug this guards: a conversation resumed the next day. Only a
    // couple of user turns elapsed (round fuse untripped) and the mood
    // band never moved, but the cached pulse is aimed at a situation
    // hours gone. Wall-clock elapsed past STALE_FUSE_MS must force a
    // refresh on its own.
    expect(
      evaluatePreRoundTrigger({
        cache: payload({
          computed_at_round: 2,
          computed_at_band: 2,
          computed_at_column: 'confident',
          computed_at_at: NOW,
        }),
        round: 3,
        mood: { band: 2, column: 'confident' },
        nowMs: NOW + STALE_FUSE_MS,
      })
    ).toBe('stale');
  });

  it('does not fire on the wall-clock fuse just under the threshold', () => {
    // A response triggered and returned to within the hour - the
    // common single-user pattern - must not force a needless recompute.
    expect(
      evaluatePreRoundTrigger({
        cache: payload({
          computed_at_round: 2,
          computed_at_band: 2,
          computed_at_column: 'confident',
          computed_at_at: NOW,
        }),
        round: 3,
        mood: { band: 2, column: 'confident' },
        nowMs: NOW + STALE_FUSE_MS - 1,
      })
    ).toBeNull();
  });
});

describe('isPayloadFreshForInjection', () => {
  it('injects a payload written within the staleness window', () => {
    expect(isPayloadFreshForInjection({ computed_at_at: NOW }, NOW)).toBe(true);
    expect(
      isPayloadFreshForInjection(
        { computed_at_at: NOW },
        NOW + STALE_FUSE_MS - 1
      )
    ).toBe(true);
  });

  it('suppresses a payload at or past the staleness window', () => {
    // The bound matches the wall-clock refresh trigger exactly: at
    // STALE_FUSE_MS the trigger fires "stale" and this guard suppresses,
    // so a refresh-that-could-not-run never leaks a stale <think> block.
    expect(
      isPayloadFreshForInjection({ computed_at_at: NOW }, NOW + STALE_FUSE_MS)
    ).toBe(false);
    expect(
      isPayloadFreshForInjection(
        { computed_at_at: NOW },
        NOW + STALE_FUSE_MS * 24
      )
    ).toBe(false);
  });
});

