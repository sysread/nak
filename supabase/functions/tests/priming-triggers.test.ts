// Deno coverage for the priming trigger evaluator (_shared/
// priming-triggers.ts). This logic schedules both the intuition and
// context-recall pipelines and now runs server-side; it is pure, so it
// gets a unit test here. The browser-side equivalent
// (tests/intuition-triggers.test.ts) was retired with the browser
// pipelines - this restores the coverage on the side that runs it.
import { assertEquals } from 'jsr:@std/assert';
import {
  countUserRounds,
  evaluatePreRoundTrigger,
  isPayloadFreshForInjection,
  STALE_FUSE_MS,
  STALE_FUSE_ROUNDS,
  type RoundCacheSnapshot,
} from '../_shared/priming-triggers.ts';

const NOW = 1_000_000_000_000;

function cache(over: Partial<RoundCacheSnapshot> = {}): RoundCacheSnapshot {
  return {
    computed_at_round: 1,
    computed_at_band: 2,
    computed_at_column: 'confident',
    computed_at_at: NOW,
    ...over,
  };
}

Deno.test('cold start (no cache) always fires', () => {
  assertEquals(
    evaluatePreRoundTrigger({ cache: null, round: 1, mood: null, nowMs: NOW }),
    'cold',
  );
});

Deno.test('same-round debounce: a cache written this round suppresses', () => {
  // computed_at_round >= round -> already refreshed this turn -> no-op,
  // even if mood shifted and the fuse would otherwise fire.
  assertEquals(
    evaluatePreRoundTrigger({
      cache: cache({ computed_at_round: 5 }),
      round: 5,
      mood: { band: 99, column: 'tentative' },
      nowMs: NOW + STALE_FUSE_MS * 10,
    }),
    null,
  );
});

Deno.test('mood band or column shift fires', () => {
  const base = cache({ computed_at_round: 1, computed_at_band: 2, computed_at_column: 'confident' });
  assertEquals(
    evaluatePreRoundTrigger({ cache: base, round: 2, mood: { band: 3, column: 'confident' }, nowMs: NOW }),
    'mood',
  );
  assertEquals(
    evaluatePreRoundTrigger({ cache: base, round: 2, mood: { band: 2, column: 'tentative' }, nowMs: NOW }),
    'mood',
  );
});

Deno.test('steady state (fresh, same mood, within fuses) does not fire', () => {
  assertEquals(
    evaluatePreRoundTrigger({
      cache: cache({ computed_at_round: 1 }),
      round: 2,
      mood: { band: 2, column: 'confident' },
      nowMs: NOW + 1000,
    }),
    null,
  );
});

Deno.test('rounds fuse fires after STALE_FUSE_ROUNDS user rounds', () => {
  assertEquals(
    evaluatePreRoundTrigger({
      cache: cache({ computed_at_round: 1 }),
      round: 1 + STALE_FUSE_ROUNDS,
      mood: { band: 2, column: 'confident' },
      nowMs: NOW + 1000,
    }),
    'stale',
  );
});

Deno.test('wall-clock fuse fires after STALE_FUSE_MS even when rounds barely moved', () => {
  assertEquals(
    evaluatePreRoundTrigger({
      cache: cache({ computed_at_round: 1, computed_at_at: NOW }),
      round: 2,
      mood: { band: 2, column: 'confident' },
      nowMs: NOW + STALE_FUSE_MS,
    }),
    'stale',
  );
});

Deno.test('isPayloadFreshForInjection: under the fuse fresh, at/over stale', () => {
  assertEquals(isPayloadFreshForInjection({ computed_at_at: NOW }, NOW + STALE_FUSE_MS - 1), true);
  assertEquals(isPayloadFreshForInjection({ computed_at_at: NOW }, NOW + STALE_FUSE_MS), false);
});

Deno.test('countUserRounds counts only user-role messages', () => {
  assertEquals(
    countUserRounds([
      { role: 'system' },
      { role: 'user' },
      { role: 'assistant' },
      { role: 'user' },
      { role: 'tool' },
      { role: 'system' },
    ]),
    2,
  );
});
