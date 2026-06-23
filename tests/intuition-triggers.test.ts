/**
 * Pure-logic coverage for the surviving intuition client helpers:
 * countUserRounds and the injection-side freshness guard. The trigger
 * scheduling that used to live here moved server-side with the
 * pre-turn priming relocation (see supabase/functions/_shared/
 * priming-triggers.ts), so the evaluatePreRoundTrigger coverage moved
 * with it.
 */
import { describe, it, expect } from 'vitest';
import {
  isPayloadFreshForInjection,
  countUserRounds,
  STALE_FUSE_MS,
} from '../src/lib/intuition';

// Fixed "now" used by the freshness-window cases.
const NOW = 1_700_000_000_000;

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

