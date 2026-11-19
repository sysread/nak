// Offline unit tests for the pivot gate: request shaping, answer
// coercion, verdict composition, and the fail-open paths. Pure: a
// fake fetch is injected so runPivotGate runs with zero network.
// The composition rules pinned here are the plan's D1/D2b contract
// (docs/dev/plans/priming-pivot-gate-plan.md).
import { assert, assertEquals } from '@std/assert';
import {
  runPivotGate,
  buildGateRequest,
  coerceGateAnswer,
  composeTrigger,
  GATE_FIRE_THRESHOLD,
} from '../venice/priming/pivot-gate.ts';
import type { RoundCacheSnapshot } from '../_shared/priming-triggers.ts';

function cache(computed_at_round: number, computed_at_at: number): RoundCacheSnapshot {
  return {
    computed_at_round,
    computed_at_band: 2,
    computed_at_column: 'confident',
    computed_at_at,
  };
}

// nowMs fixed so wall-clock arithmetic is deterministic: the cache is
// 10 minutes old - well inside the 1h wall-clock fuse.
const NOW = 1_800_000_000_000;
const TEN_MIN = 10 * 60 * 1000;

Deno.test('buildGateRequest carries a digest, never the transcript', () => {
  const body = buildGateRequest({
    userText: 'ok now help me plan the lasagna for saturday',
    intuitionCache: {
      ...cache(3, NOW - TEN_MIN),
      perception: 'Classification: cooking planning\nThe user cooks often.',
      synthesis: 'The user is mid-meal-prep and has asked about pasta twice.'.repeat(200),
    },
    recallCache: {
      ...cache(2, NOW - TEN_MIN),
      note: 'Prior conversation covered the pasta machine purchase.^1^'.repeat(50),
    },
    round: 9,
    mood: { band: 2, column: 'confident' },
    nowMs: NOW,
  });
  const state = body.state as Record<string, unknown>;
  // User text is capped but present whole (it is short).
  assertEquals(state.user_message, 'ok now help me plan the lasagna for saturday');
  const intu = state.cached_intuition as Record<string, unknown>;
  // The perception is digested to its Classification line...
  assertEquals(intu.classification, 'Classification: cooking planning');
  // ...and the synthesis to a capped head.
  const head = intu.synthesis_head as string;
  assert(head.length <= 600);
  assert(head.startsWith('The user is mid-meal-prep'));
  assertEquals(intu.rounds_ago, 6);
  const rec = state.cached_recall as Record<string, unknown>;
  assert((rec.note_head as string).length <= 400);
  // Mood rides along.
  assertEquals(state.mood, { band: 2, column: 'confident' });
  // And the transcript is nowhere: no message array, no history key.
  assertEquals(state.history, undefined);
  assertEquals(state.messages, undefined);
});

Deno.test('buildGateRequest omits cache blocks and mood when absent', () => {
  const body = buildGateRequest({
    userText: 'hey',
    intuitionCache: null,
    recallCache: null,
    round: 1,
    mood: null,
    nowMs: NOW,
  });
  const state = body.state as Record<string, unknown>;
  assertEquals(state.cached_intuition, undefined);
  assertEquals(state.cached_recall, undefined);
  assertEquals(state.mood, undefined);
});

Deno.test('coerceGateAnswer reads the pivot noul and clamps', () => {
  assertEquals(coerceGateAnswer({ answers: { pivot: { type: 'noul', noul: 0.83 } } }), 0.83);
  assertEquals(coerceGateAnswer({ answers: { pivot: { noul: 1.7 } } }), 1);
  assertEquals(coerceGateAnswer({ answers: { pivot: { noul: -3 } } }), 0);
  assertEquals(coerceGateAnswer({ answers: { other: { noul: 0.9 } } }), null);
  assertEquals(coerceGateAnswer({ answers: { pivot: {} } }), null);
  assertEquals(coerceGateAnswer({ answers: 'garbage' }), null);
  assertEquals(coerceGateAnswer(null), null);
});

// The composition matrix. Cache is round-fuse-stale but wall-clock
// fresh unless stated.
const STALE_VERDICT = 'stale' as const;

Deno.test('composeTrigger: cold and mood pass through untouched', () => {
  for (const verdict of ['cold', 'mood'] as const) {
    assertEquals(
      composeTrigger({ verdict, cache: cache(3, NOW - TEN_MIN), round: 9, nowMs: NOW, gatePivot: 0.99 }),
      verdict,
    );
  }
});

Deno.test('composeTrigger: veto holds when the gate says the cache informs', () => {
  assertEquals(
    composeTrigger({ verdict: STALE_VERDICT, cache: cache(3, NOW - TEN_MIN), round: 9, nowMs: NOW, gatePivot: 0.2 }),
    null,
  );
  // At the threshold exactly, the gate fires (>= is the contract).
  assertEquals(
    composeTrigger({ verdict: STALE_VERDICT, cache: cache(3, NOW - TEN_MIN), round: 9, nowMs: NOW, gatePivot: GATE_FIRE_THRESHOLD }),
    'pivot',
  );
});

Deno.test('composeTrigger: a wall-clock-stale cache can never be vetoed', () => {
  // 2 hours old: past the 1h fuse even though the round fuse also fired.
  assertEquals(
    composeTrigger({ verdict: STALE_VERDICT, cache: cache(3, NOW - 2 * 60 * 60 * 1000), round: 9, nowMs: NOW, gatePivot: 0.01 }),
    'stale',
  );
  // The same wall-clock-stale cache stays 'stale' even with a confident gate.
  assertEquals(
    composeTrigger({ verdict: STALE_VERDICT, cache: cache(3, NOW - 2 * 60 * 60 * 1000), round: 9, nowMs: NOW, gatePivot: 0.99 }),
    'stale',
  );
});

Deno.test('composeTrigger: unusable gate fails open to the deterministic verdict', () => {
  assertEquals(
    composeTrigger({ verdict: STALE_VERDICT, cache: cache(3, NOW - TEN_MIN), round: 9, nowMs: NOW, gatePivot: null }),
    'stale',
  );
  assertEquals(
    composeTrigger({ verdict: null, cache: cache(3, NOW - TEN_MIN), round: 9, nowMs: NOW, gatePivot: null }),
    null,
  );
});

Deno.test('composeTrigger: pivot fires on a no-trigger turn with a live cache', () => {
  assertEquals(
    composeTrigger({ verdict: null, cache: cache(3, NOW - TEN_MIN), round: 9, nowMs: NOW, gatePivot: 0.92 }),
    'pivot',
  );
  // Below threshold: no fire.
  assertEquals(
    composeTrigger({ verdict: null, cache: cache(3, NOW - TEN_MIN), round: 9, nowMs: NOW, gatePivot: 0.4 }),
    null,
  );
});

Deno.test('composeTrigger: never fires through the same-round debounce', () => {
  // Cache written THIS round: the evaluator's debounce (computed_at_round
  // >= round) must hold even with a screaming pivot probability.
  assertEquals(
    composeTrigger({ verdict: null, cache: cache(9, NOW - TEN_MIN), round: 9, nowMs: NOW, gatePivot: 0.99 }),
    null,
  );
});

Deno.test('composeTrigger: never fires or vetoes on a cold (no-cache) turn', () => {
  assertEquals(
    composeTrigger({ verdict: null, cache: null, round: 1, nowMs: NOW, gatePivot: 0.99 }),
    null,
  );
});

Deno.test('runPivotGate resolves the probability through a fake fetch', async () => {
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    assertEquals(String(url), 'https://api.venice.ai/api/v1/decisions');
    const body = JSON.parse((init?.body as string) ?? '{}');
    assertEquals(body.model, 'clef-api');
    return Promise.resolve(
      new Response(JSON.stringify({ model: 'clef-api', answers: { pivot: { type: 'noul', noul: 0.88 } }, usage: {} }), { status: 200 })
    );
  }) as typeof fetch;
  const p = await runPivotGate({
    userText: 'switching gears - tax question',
    intuitionCache: null,
    recallCache: null,
    round: 4,
    mood: null,
    nowMs: NOW,
    apiKey: 'k',
    log: { debug: () => {} },
    fetchImpl: fakeFetch,
  });
  assertEquals(p, 0.88);
});

Deno.test('runPivotGate fails open on transport failure', async () => {
  const p = await runPivotGate({
    userText: 'x',
    intuitionCache: null,
    recallCache: null,
    round: 4,
    mood: null,
    nowMs: NOW,
    apiKey: 'k',
    log: { debug: () => {} },
    fetchImpl: (() => Promise.reject(new Error('boom'))) as typeof fetch,
  });
  assertEquals(p, null);
});

Deno.test('runPivotGate fails open on the deadline (hung fetch)', async () => {
  const p = await runPivotGate({
    userText: 'x',
    intuitionCache: null,
    recallCache: null,
    round: 4,
    mood: null,
    nowMs: NOW,
    apiKey: 'k',
    signal: undefined,
    log: { debug: () => {} },
    // Never settles: the deadline must resolve null, not hang.
    fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
  });
  assertEquals(p, null);
  // The suite stays honest: this test took ~the deadline, not forever.
});
