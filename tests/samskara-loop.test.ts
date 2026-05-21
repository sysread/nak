/**
 * Coverage for the samskara worker cycle driver. Same pattern as
 * embeddings-loop.test.ts and reflection-loop.test.ts: drive
 * runOneCycle directly, mock at the SupabaseService + Venice + agent
 * seam. The Web Worker entry point in worker.ts is a thin wrapper
 * around this driver and tested separately if at all.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runOneCycle,
  napForResult,
  PHASES,
  type CycleContext,
  type CycleResult,
  type NapConfig,
} from '../src/lib/agents/samskara/loop';
import { LeaseCoordinator, type LeaseTimers } from '../src/lib/embeddings/lease';
import type { SupabaseService } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';
import type { SamskaraAgent } from '../src/lib/agents/samskara/agent';

function buildCoordinator(): {
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
    'samskara',
    'holder-test',
    { ttlSeconds: 45, heartbeatMs: 20_000 },
    timers
  );
  return { coordinator, leaseSpies };
}

function fakeAgent(overrides: Partial<SamskaraAgent> = {}): SamskaraAgent {
  return {
    assimilate: vi.fn(async () => null),
    relate: vi.fn(async () => null),
    mint: vi.fn(async () => null),
    classifyReaction: vi.fn(async () => null),
    summarizeCompound: vi.fn(async () => null),
    ...overrides,
  } as unknown as SamskaraAgent;
}

function fakeSupabase(overrides: Partial<SupabaseService> = {}): SupabaseService {
  return {
    samskaraClaimNextAssimilate: vi.fn(async () => null),
    samskaraSaveAssimilation: vi.fn(async () => true),
    samskaraRecentEmbeddedSubstrate: vi.fn(async () => []),
    samskaraDecay: vi.fn(async () => 0),
    samskaraCollapseByCofiring: vi.fn(async () => 0),
    samskaraShouldRegenCompound: vi.fn(async () => ({
      shouldRegen: false,
      samskaraCount: 0,
      lastRegenAt: null,
    })),
    samskaraClaimCompoundRegen: vi.fn(async () => false),
    samskaraTopForSummary: vi.fn(async () => []),
    samskaraSaveCompoundSummary: vi.fn(async () => false),
    samskaraApplyReaction: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => []),
    ...overrides,
  } as unknown as SupabaseService;
}

function fakeVenice(): VeniceClient {
  return {
    embed: vi.fn(async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] })),
  } as unknown as VeniceClient;
}

function buildCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  const { coordinator } = buildCoordinator();
  return {
    agent: fakeAgent(),
    supabase: fakeSupabase(),
    venice: fakeVenice(),
    coordinator,
    holderId: 'holder-test',
    claimTtlSeconds: 600,
    regenClaimTtlSeconds: 1200,
    phase: 'decay',
    signal: new AbortController().signal,
    onLeaseLost: () => {},
    ...overrides,
  };
}

describe('samskara runOneCycle - lease handling', () => {
  it('returns polling when the lease cannot be acquired', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(false);
    const ctx = buildCtx({ coordinator, phase: 'decay' });
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('polling');
  });

  it('returns acquired-lease and defers work until the next cycle', async () => {
    const { coordinator } = buildCoordinator();
    const ctx = buildCtx({ coordinator, phase: 'decay' });
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('acquired-lease');
    expect(coordinator.isHolding).toBe(true);
  });
});

describe('samskara runOneCycle - decay phase', () => {
  it('runs the decay RPC and reports empty-phase so the worker can idle', async () => {
    const { coordinator } = buildCoordinator();
    const decay = vi.fn(async () => 5);
    const supabase = fakeSupabase({ samskaraDecay: decay } as Partial<SupabaseService>);
    const ctx = buildCtx({ coordinator, supabase, phase: 'decay' });
    await runOneCycle(ctx); // acquired-lease
    const result = await runOneCycle(ctx);
    expect(decay).toHaveBeenCalled();
    // Decay is pure cache maintenance - the SQL update has no
    // consumer inside the worker. Returning 'progress' would
    // pin the outer worker's allEmpty gate false on every
    // rotation, defeating the idle nap and spinning every other
    // phase's per-rotation queries at full speed.
    expect(result).toBe<CycleResult>('empty-phase');
  });

  it('returns error when the decay RPC throws', async () => {
    const { coordinator } = buildCoordinator();
    const supabase = fakeSupabase({
      samskaraDecay: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as Partial<SupabaseService>);
    const ctx = buildCtx({ coordinator, supabase, phase: 'decay' });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('error');
  });
});

describe('samskara runOneCycle - assimilate phase', () => {
  it('returns empty-phase when the queue has nothing pending', async () => {
    const { coordinator } = buildCoordinator();
    const ctx = buildCtx({ coordinator, phase: 'assimilate' });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-phase');
  });

  it('claims a row, fetches messages, calls the agent, saves output', async () => {
    const { coordinator } = buildCoordinator();
    const claim = vi.fn(async () => ({
      id: 'sub-1',
      threadId: 't-1',
      userMessageId: 'um-1',
      assistantMessageId: 'am-1',
    }));
    const save = vi.fn(async () => true);
    const listMessages = vi.fn(async () => [
      {
        id: 'um-1',
        role: 'user',
        content: 'hi',
        created_at: '',
        thread_id: 't-1',
      },
      {
        id: 'am-1',
        role: 'assistant',
        content: 'hello',
        created_at: '',
        thread_id: 't-1',
      },
    ]);
    const supabase = fakeSupabase({
      samskaraClaimNextAssimilate: claim,
      samskaraSaveAssimilation: save,
      listMessages,
    } as unknown as Partial<SupabaseService>);
    const assimilate = vi.fn(async () => ({
      situation: 's',
      outcome: 'o',
      valence: 0.2,
    }));
    const agent = fakeAgent({ assimilate } as unknown as Partial<SamskaraAgent>);
    const ctx = buildCtx({ coordinator, supabase, agent, phase: 'assimilate' });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(claim).toHaveBeenCalled();
    expect(assimilate).toHaveBeenCalledWith('hi', 'hello', expect.anything());
    expect(save).toHaveBeenCalledWith('sub-1', 'holder-test', 's', 'o', 0.2);
    expect(result).toBe<CycleResult>('progress');
  });
});

describe('samskara runOneCycle - compound-regen phase', () => {
  it('returns empty-phase when the trigger says no regen needed', async () => {
    const { coordinator } = buildCoordinator();
    const supabase = fakeSupabase({
      samskaraShouldRegenCompound: vi.fn(async () => ({
        shouldRegen: false,
        samskaraCount: 5,
        lastRegenAt: null,
      })),
    } as Partial<SupabaseService>);
    const ctx = buildCtx({ coordinator, supabase, phase: 'compound-regen' });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-phase');
  });

  it('returns empty-phase when another device already holds the regen claim', async () => {
    const { coordinator } = buildCoordinator();
    const supabase = fakeSupabase({
      samskaraShouldRegenCompound: vi.fn(async () => ({
        shouldRegen: true,
        samskaraCount: 5,
        lastRegenAt: null,
      })),
      samskaraClaimCompoundRegen: vi.fn(async () => false),
    } as Partial<SupabaseService>);
    const ctx = buildCtx({ coordinator, supabase, phase: 'compound-regen' });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-phase');
  });
});

describe('napForResult', () => {
  const cfg: NapConfig = {
    leasePollMs: 20_000,
    idleIntervalMs: 60_000,
    errorBackoffMs: 15_000,
    rateLimitBackoffMs: 60_000,
  };
  it.each<[CycleResult, number]>([
    ['acquired-lease', 0],
    ['progress', 0],
    ['save-rejected', 0],
    ['polling', 20_000],
    // empty-phase is 0 inside the cycle (the worker accumulates a
    // longest-nap across the rotation and idles only when ALL phases
    // came back empty).
    ['empty-phase', 0],
    ['error', 15_000],
    ['rate-limited', 60_000],
  ])('maps %s to %d ms', (result, expected) => {
    expect(napForResult(result, cfg)).toBe(expected);
  });
});

describe('samskara runOneCycle - dedup phase', () => {
  it('returns empty-phase when the RPC collapses nothing', async () => {
    const { coordinator } = buildCoordinator();
    const collapse = vi.fn(async () => 0);
    const supabase = fakeSupabase({
      samskaraCollapseByCofiring: collapse,
    } as Partial<SupabaseService>);
    const ctx = buildCtx({ coordinator, supabase, phase: 'dedup' });
    await runOneCycle(ctx); // acquired-lease
    const result = await runOneCycle(ctx);
    expect(collapse).toHaveBeenCalled();
    expect(result).toBe<CycleResult>('empty-phase');
  });

  it('reports progress when the RPC collapses at least one pair', async () => {
    const { coordinator } = buildCoordinator();
    const collapse = vi.fn(async () => 3);
    const supabase = fakeSupabase({
      samskaraCollapseByCofiring: collapse,
    } as Partial<SupabaseService>);
    const ctx = buildCtx({ coordinator, supabase, phase: 'dedup' });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('progress');
  });

  it('returns error when the RPC throws', async () => {
    const { coordinator } = buildCoordinator();
    const supabase = fakeSupabase({
      samskaraCollapseByCofiring: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as Partial<SupabaseService>);
    const ctx = buildCtx({ coordinator, supabase, phase: 'dedup' });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('error');
  });
});

describe('PHASES', () => {
  it('lists every phase in the deliberate rotation order', () => {
    expect(PHASES).toEqual([
      'assimilate',
      'pair-relate',
      'mint-tier1',
      'mint-tier2',
      'reaction-classify',
      'decay',
      'dedup',
      'compound-regen',
    ]);
  });
});
