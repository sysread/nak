/**
 * Coverage for the bias-observer cycle driver. Mocks at the
 * SupabaseService + Venice + agent seam exactly like
 * samskara-loop.test.ts and reflection-loop.test.ts; the Web Worker
 * entry in worker.ts is a thin wrapper around the driver and is
 * tested only when the structured-clone surface changes.
 *
 * Two phases to exercise:
 *
 *   - aggregate: always runs end-to-end regardless of observations.
 *     The cold-start case (no rows in bias_observations) still
 *     produces N catalog-sized upserts, all rendering as 'elided' on
 *     the prior alone.
 *
 *   - analyze: claim -> agent -> save with the optimistic-
 *     concurrency guard. Three save outcomes the test pins:
 *     successful save, save-rejected (message count drifted), and
 *     agent-null (parse failure / transient).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runOneCycle,
  type CycleContext,
  type CycleResult,
} from '../src/lib/agents/bias/loop';
import { LeaseCoordinator, type LeaseTimers } from '../src/lib/embeddings/lease';
import type { SupabaseService } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';
import type { BiasObserverAgent } from '../src/lib/agents/bias/agent';
import { BIAS_KEYS } from '../src/lib/bias/catalog-keys';

function buildCoordinator(initiallyHolding = false): {
  coordinator: LeaseCoordinator;
  leaseSpies: {
    acquireWorkerLease: ReturnType<typeof vi.fn>;
    heartbeatWorkerLease: ReturnType<typeof vi.fn>;
    releaseWorkerLease: ReturnType<typeof vi.fn>;
  };
} {
  const leaseSpies = {
    acquireWorkerLease: vi.fn(async () => true),
    heartbeatWorkerLease: vi.fn(async () => true),
    releaseWorkerLease: vi.fn(async () => undefined),
  };
  const handle = Symbol('h') as unknown as ReturnType<typeof setInterval>;
  const timers: LeaseTimers = {
    setInterval: () => handle,
    clearInterval: () => {},
  };
  const coordinator = new LeaseCoordinator(
    leaseSpies as unknown as SupabaseService,
    'bias',
    'holder-test',
    { ttlSeconds: 45, heartbeatMs: 20_000 },
    timers
  );
  if (initiallyHolding) {
    // Promote into the "holding" state by acquiring once; the spy
    // returns true so this is a no-network step.
    return Object.assign(
      { coordinator, leaseSpies },
      { initWith: () => coordinator.acquire() }
    );
  }
  return { coordinator, leaseSpies };
}

function fakeAgent(overrides: Partial<BiasObserverAgent> = {}): BiasObserverAgent {
  const defaults: Partial<BiasObserverAgent> = {
    observe: vi.fn(async () => ({ observations: [], reactions: [] })),
  };
  return { ...defaults, ...overrides } as BiasObserverAgent;
}

function fakeSupabase(overrides: Partial<SupabaseService> = {}): SupabaseService {
  const defaults: Partial<SupabaseService> = {
    biasClaimNextThread: vi.fn(async () => null),
    biasSaveObservations: vi.fn(async () => true),
    biasProcessedThreadsForBias: vi.fn(async () => []),
    biasReactionsForBias: vi.fn(async () => []),
    biasUpsertSummary: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => []),
  };
  return { ...defaults, ...overrides } as SupabaseService;
}

function buildContext(opts: {
  phase: 'analyze' | 'aggregate';
  supabase: SupabaseService;
  agent?: BiasObserverAgent;
  excludeIds?: readonly string[];
  aggregateDirty?: { value: boolean };
}): { ctx: CycleContext; signal: AbortSignal; aggregateDirty: { value: boolean } } {
  const controller = new AbortController();
  const { coordinator } = buildCoordinator();
  const aggregateDirty = opts.aggregateDirty ?? { value: true };
  return {
    ctx: {
      agent: opts.agent ?? fakeAgent(),
      supabase: opts.supabase,
      venice: {} as VeniceClient,
      coordinator,
      holderId: 'holder-test',
      claimTtlSeconds: 60,
      phase: opts.phase,
      signal: controller.signal,
      onLeaseLost: () => {},
      excludeThreadIds: () => opts.excludeIds ?? [],
      aggregateDirty,
    },
    signal: controller.signal,
    aggregateDirty,
  };
}

async function runUntilLeaseHeld(ctx: CycleContext): Promise<CycleResult> {
  // First call acquires the lease and returns 'acquired-lease' or
  // 'polling'; the second call is the real phase exercise.
  await runOneCycle(ctx);
  return runOneCycle(ctx);
}

describe('aggregate phase', () => {
  it('upserts one summary row per catalog entry on cold start', async () => {
    const supabase = fakeSupabase();
    // Cold-start: worker seeds dirty=true so the first rotation
    // actually fills the cache.
    const { ctx, aggregateDirty } = buildContext({ phase: 'aggregate', supabase });
    const result = await runUntilLeaseHeld(ctx);
    // Cache maintenance reports as 'empty-phase' so the outer
    // worker's idle-sleep gate stays correct - the upsert work
    // happened, but nothing else inside the worker reacts to it.
    expect(result).toBe('empty-phase');
    // 19 catalog entries -> 19 upserts; with no observations every
    // row reflects the prior alone (tier='elided').
    expect((supabase.biasUpsertSummary as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      BIAS_KEYS.length
    );
    const firstCall = (supabase.biasUpsertSummary as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCall.tier).toBe('elided');
    expect(firstCall.effectiveN).toBe(0);
    // Aggregate consumed the dirty flag - the next rotation will
    // short-circuit until analyze flags it again.
    expect(aggregateDirty.value).toBe(false);
  });

  it('short-circuits with zero RPCs when the cache is clean', async () => {
    // Reproduces the per-rotation idle case: analyze hasn't saved
    // anything since the last aggregate, so the gate skips the
    // N_catalog * 3 round-trips.
    const supabase = fakeSupabase();
    const { ctx } = buildContext({
      phase: 'aggregate',
      supabase,
      aggregateDirty: { value: false },
    });
    const result = await runUntilLeaseHeld(ctx);
    expect(result).toBe('empty-phase');
    expect(supabase.biasUpsertSummary).not.toHaveBeenCalled();
    expect(supabase.biasProcessedThreadsForBias).not.toHaveBeenCalled();
    expect(supabase.biasReactionsForBias).not.toHaveBeenCalled();
  });

  it('runs the math with observations and lifts tier when evidence clears thresholds', async () => {
    // Stub the per-bias list to fake "30 of 80 threads exhibit
    // confirmation_bias at p_conv ~0.8, all recent." This matches
    // the strong-tier worked example from the design doc.
    const supabase = fakeSupabase({
      biasProcessedThreadsForBias: vi.fn(async (bias: string) => {
        if (bias !== 'confirmation_bias') {
          // Other biases land 50 non-hit rows so the denominator
          // pushes them above the N_eff floor but below the soft
          // threshold.
          return Array.from({ length: 50 }, (_, i) => ({
            threadId: `t-${bias}-${i}`,
            processedAt: new Date().toISOString(),
            pConv: 0,
          }));
        }
        const rows: { threadId: string; processedAt: string; pConv: number }[] = [];
        for (let i = 0; i < 50; i++) {
          rows.push({
            threadId: `t-hit-${i}`,
            processedAt: new Date().toISOString(),
            pConv: 0.8,
          });
        }
        for (let i = 0; i < 30; i++) {
          rows.push({
            threadId: `t-miss-${i}`,
            processedAt: new Date().toISOString(),
            pConv: 0,
          });
        }
        return rows;
      }),
    });
    const { ctx } = buildContext({ phase: 'aggregate', supabase });
    const result = await runUntilLeaseHeld(ctx);
    expect(result).toBe('empty-phase');
    const upserts = (supabase.biasUpsertSummary as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0]
    );
    const confirmationRow = upserts.find((r) => r.bias === 'confirmation_bias');
    expect(confirmationRow).toBeDefined();
    expect(confirmationRow!.tier).toBe('strong');
    // A non-hit bias with the same denominator stays elided.
    const sunkRow = upserts.find((r) => r.bias === 'sunk_cost_fallacy');
    expect(sunkRow!.tier).toBe('elided');
  });
});

describe('analyze phase', () => {
  it('returns empty-phase when no thread is eligible', async () => {
    const supabase = fakeSupabase();
    const { ctx } = buildContext({ phase: 'analyze', supabase });
    const result = await runUntilLeaseHeld(ctx);
    expect(result).toBe('empty-phase');
    expect(supabase.biasClaimNextThread).toHaveBeenCalled();
    expect(supabase.biasSaveObservations).not.toHaveBeenCalled();
  });

  it('saves agent observations through the floor/cap clamp', async () => {
    const supabase = fakeSupabase({
      biasClaimNextThread: vi.fn(async () => ({
        threadId: 't-1',
        userMessageCount: 5,
        activeBiases: [] as string[],
      })),
      listMessages: vi.fn(async () => [
        { id: 'm1', role: 'user', content: 'hello', thread_id: 't-1', created_at: new Date().toISOString() },
        { id: 'm2', role: 'assistant', content: 'hi', thread_id: 't-1', created_at: new Date().toISOString() },

      ] as any),
      biasSaveObservations: vi.fn(async () => true),
    });
    const agent = fakeAgent({
      observe: vi.fn(async () => ({
        observations: [
          {
            bias: 'confirmation_bias' as const,
            confidence: 0.95, // Above cap; should be clamped to 0.85.
            reasoning: 'short',
            evidenceMessageId: 'm1' as string | null,
          },
          {
            bias: 'sunk_cost_fallacy' as const,
            confidence: 0.30, // Below floor; should be dropped.
            reasoning: 'short',
            evidenceMessageId: 'm1' as string | null,
          },
        ],
        reactions: [],
      })),
    });
    // Seed dirty=false so we can assert analyze flags it on the
    // successful save. Without the flip, aggregate would never
    // re-run and the cache would diverge from the saved
    // observations.
    const { ctx, aggregateDirty } = buildContext({
      phase: 'analyze',
      supabase,
      agent,
      aggregateDirty: { value: false },
    });
    const result = await runUntilLeaseHeld(ctx);
    expect(result).toBe('progress');
    expect(aggregateDirty.value).toBe(true);
    const saveCall = (supabase.biasSaveObservations as ReturnType<typeof vi.fn>).mock
      .calls[0];
    // [threadId, holderId, expectedMsgCount, observations, reactions]
    expect(saveCall[3]).toEqual([
      {
        bias: 'confirmation_bias',
        confidence: 0.85,
        reasoning: 'short',
        evidence_message_id: 'm1',
      },
    ]);
    // Reactions slot is empty because the agent stub returned no
    // reactions and the claim had an empty active-bias set. The
    // dedicated reactor test below exercises the populated path.
    expect(saveCall[4]).toEqual([]);
  });

  it('passes activeBiases to the agent and persists the resulting reactions', async () => {
    const supabase = fakeSupabase({
      biasClaimNextThread: vi.fn(async () => ({
        threadId: 't-1',
        userMessageCount: 5,
        activeBiases: ['confirmation_bias'] as string[],
      })),
      listMessages: vi.fn(async () => [
        { id: 'm1', role: 'user', content: 'good point', thread_id: 't-1', created_at: new Date().toISOString() },
      ] as Awaited<ReturnType<SupabaseService['listMessages']>>),
      biasSaveObservations: vi.fn(async () => true),
    });
    const observeSpy = vi.fn(async () => ({
      observations: [],
      reactions: [
        {
          bias: 'confirmation_bias' as const,
          wasConfirmed: true as boolean | null,
          reasoning: 'user said "good point"',
        },
      ],
    }));
    const agent = fakeAgent({ observe: observeSpy });
    const { ctx } = buildContext({ phase: 'analyze', supabase, agent });
    const result = await runUntilLeaseHeld(ctx);
    expect(result).toBe('progress');
    // The agent received the active-bias list from the claim.
    const observeCalls = (observeSpy as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    // [transcript, activeBiases, signal]
    expect(observeCalls[0][1]).toEqual(['confirmation_bias']);
    // The save call carries the reactions in slot 4, mapped to the
    // wire shape (was_confirmed snake-case).
    const saveCall = (supabase.biasSaveObservations as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(saveCall[4]).toEqual([
      {
        bias: 'confirmation_bias',
        was_confirmed: true,
        reasoning: 'user said "good point"',
      },
    ]);
  });

  it('reports save-rejected when the RPC returns false (race lost)', async () => {
    const supabase = fakeSupabase({
      biasClaimNextThread: vi.fn(async () => ({
        threadId: 't-1',
        userMessageCount: 5,
        activeBiases: [] as string[],
      })),
      listMessages: vi.fn(async () => [
        { id: 'm1', role: 'user', content: 'hello', thread_id: 't-1', created_at: new Date().toISOString() },

      ] as any),
      biasSaveObservations: vi.fn(async () => false),
    });
    const { ctx } = buildContext({ phase: 'analyze', supabase });
    const result = await runUntilLeaseHeld(ctx);
    expect(result).toBe('save-rejected');
  });

  it('reports error when the agent parse-fails', async () => {
    const supabase = fakeSupabase({
      biasClaimNextThread: vi.fn(async () => ({
        threadId: 't-1',
        userMessageCount: 5,
        activeBiases: [] as string[],
      })),
      listMessages: vi.fn(async () => [
        { id: 'm1', role: 'user', content: 'hello', thread_id: 't-1', created_at: new Date().toISOString() },

      ] as any),
    });
    const agent = fakeAgent({
      observe: vi.fn(async () => null),
    });
    const { ctx } = buildContext({ phase: 'analyze', supabase, agent });
    const result = await runUntilLeaseHeld(ctx);
    expect(result).toBe('error');
    expect(supabase.biasSaveObservations).not.toHaveBeenCalled();
  });

  it('passes the exclude set into the claim RPC', async () => {
    const supabase = fakeSupabase();
    const { ctx } = buildContext({
      phase: 'analyze',
      supabase,
      excludeIds: ['t-open-1', 't-open-2'],
    });
    await runUntilLeaseHeld(ctx);
    const claimCall = (supabase.biasClaimNextThread as ReturnType<typeof vi.fn>).mock
      .calls[0];
    // [holderId, ttl, excludeIds, todayStartUtc, minUserMessages]
    expect(claimCall[2]).toEqual(['t-open-1', 't-open-2']);
  });
});
