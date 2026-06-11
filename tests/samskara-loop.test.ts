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
    samskaraTier2Candidate: vi.fn(async () => []),
    samskaraNearestByPrediction: vi.fn(async () => []),
    samskaraReinforceExisting: vi.fn(async () => true),
    embed: vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2] as number[] }] })),
    listMessages: vi.fn(async () => []),
    ...overrides,
  } as unknown as SupabaseService;
}

/**
 * Chainable mock of the raw Supabase client the mint phases reach
 * through (`ctx.supabase.client`). Records the row passed to
 * `.from('samskaras').insert(...)` and the rows passed to
 * `.from('samskara_provenance').upsert(...)` so tests can assert tier
 * and provenance shape without a real PostgREST.
 */
function fakeClient(insertId = 't2-new'): {
  client: unknown;
  inserted: Record<string, unknown>[];
  provRows: Record<string, unknown>[][];
} {
  const inserted: Record<string, unknown>[] = [];
  const provRows: Record<string, unknown>[][] = [];
  const client = {
    from: (table: string) => {
      if (table === 'samskaras') {
        return {
          insert: (row: Record<string, unknown>) => {
            inserted.push(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: insertId }, error: null }),
              }),
            };
          },
        };
      }
      return {
        upsert: async (rows: Record<string, unknown>[]) => {
          provRows.push(rows);
          return { error: null };
        },
      };
    },
  };
  return { client, inserted, provRows };
}

function buildCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  const { coordinator } = buildCoordinator();
  return {
    agent: fakeAgent(),
    supabase: fakeSupabase(),
    coordinator,
    holderId: 'holder-test',
    claimTtlSeconds: 600,
    regenClaimTtlSeconds: 1200,
    phase: 'decay',
    signal: new AbortController().signal,
    onLeaseLost: () => {},
    // Empty map = nothing throttled yet, which preserves the
    // existing tests' assumption that exploratory phases run
    // unimpeded. Tests that exercise the throttle gate seed the
    // map explicitly.
    phaseThrottle: {
      lastRunMs: new Map(),
      minIntervalMs: 60 * 1000,
    },
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

describe('samskara runOneCycle - phase throttle (mint-tier1, pair-relate)', () => {
  it('mint-tier1 skips entirely when throttled, no substrate fetch fires', async () => {
    const { coordinator } = buildCoordinator();
    const substrateFetch = vi.fn(async () => []);
    const supabase = fakeSupabase({
      samskaraRecentEmbeddedSubstrate: substrateFetch,
    } as Partial<SupabaseService>);
    // Seed lastRunMs at "just now" so the throttle window is wide
    // open. The phase must return empty-phase before touching the
    // expensive substrate fetch.
    const ctx = buildCtx({
      coordinator,
      supabase,
      phase: 'mint-tier1',
      phaseThrottle: {
        lastRunMs: new Map([['mint-tier1', Date.now()]]),
        minIntervalMs: 60_000,
      },
    });
    await runOneCycle(ctx); // acquired-lease
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-phase');
    expect(substrateFetch).not.toHaveBeenCalled();
  });

  it('pair-relate skips entirely when throttled, no substrate fetch fires', async () => {
    const { coordinator } = buildCoordinator();
    const substrateFetch = vi.fn(async () => []);
    const supabase = fakeSupabase({
      samskaraRecentEmbeddedSubstrate: substrateFetch,
    } as Partial<SupabaseService>);
    const ctx = buildCtx({
      coordinator,
      supabase,
      phase: 'pair-relate',
      phaseThrottle: {
        lastRunMs: new Map([['pair-relate', Date.now()]]),
        minIntervalMs: 60_000,
      },
    });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-phase');
    expect(substrateFetch).not.toHaveBeenCalled();
  });

  it('mint-tier1 stamps the throttle clock after a successful substrate fetch', async () => {
    const { coordinator } = buildCoordinator();
    const supabase = fakeSupabase({
      // Less than 4 rows so the mint exits early - but the
      // substrate fetch DID succeed, so the stamp must land
      // anyway. Otherwise the next rotation would re-fetch.
      samskaraRecentEmbeddedSubstrate: vi.fn(async () => [
        { id: 'a', situation: 's', outcome: 'o', valence: 0, situation_embedding: [0, 0] as number[], created_at: new Date().toISOString() },
      ] as unknown as Awaited<ReturnType<SupabaseService['samskaraRecentEmbeddedSubstrate']>>),
    } as Partial<SupabaseService>);
    const throttle = {
      lastRunMs: new Map<typeof PHASES[number], number>(),
      minIntervalMs: 60_000,
    };
    const ctx = buildCtx({
      coordinator,
      supabase,
      phase: 'mint-tier1',
      phaseThrottle: throttle,
    });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-phase');
    expect(throttle.lastRunMs.get('mint-tier1')).toBeGreaterThan(0);
  });

  it('mint-tier1 does NOT stamp when the substrate fetch errors (retries soon)', async () => {
    const { coordinator } = buildCoordinator();
    const supabase = fakeSupabase({
      samskaraRecentEmbeddedSubstrate: vi.fn(async () => {
        throw new Error('network');
      }),
    } as Partial<SupabaseService>);
    const throttle = {
      lastRunMs: new Map<typeof PHASES[number], number>(),
      minIntervalMs: 60_000,
    };
    const ctx = buildCtx({
      coordinator,
      supabase,
      phase: 'mint-tier1',
      phaseThrottle: throttle,
    });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('error');
    // No stamp - error back-off handles retry cadence, the phase
    // throttle shouldn't suppress retries of a transient failure.
    expect(throttle.lastRunMs.has('mint-tier1')).toBe(false);
  });

  it('runs normally once the throttle window has elapsed', async () => {
    const { coordinator } = buildCoordinator();
    const substrateFetch = vi.fn(async () => []);
    const supabase = fakeSupabase({
      samskaraRecentEmbeddedSubstrate: substrateFetch,
    } as Partial<SupabaseService>);
    const ctx = buildCtx({
      coordinator,
      supabase,
      phase: 'pair-relate',
      // Last run was 10 minutes ago - well past the 60s window.
      phaseThrottle: {
        lastRunMs: new Map([['pair-relate', Date.now() - 10 * 60 * 1000]]),
        minIntervalMs: 60_000,
      },
    });
    await runOneCycle(ctx);
    await runOneCycle(ctx);
    expect(substrateFetch).toHaveBeenCalled();
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

describe('samskara runOneCycle - mint-tier1 topical clustering', () => {
  // Recency-ordered substrate window (most-recent first). The seed and
  // c1/c2 share a topic (near-parallel embeddings); off1/off2 are
  // orthogonal. The cluster builder should keep seed+c1+c2 and drop the
  // off-topic rows, so both the minter sample and the provenance batch
  // are topically coherent.
  function substrateRow(
    id: string,
    embedding: number[]
  ): Awaited<ReturnType<SupabaseService['samskaraRecentEmbeddedSubstrate']>>[number] {
    return {
      id,
      situation: `situation ${id}`,
      outcome: `outcome ${id}`,
      valence: 0,
      situation_embedding: embedding,
      created_at: new Date().toISOString(),
    } as unknown as Awaited<
      ReturnType<SupabaseService['samskaraRecentEmbeddedSubstrate']>
    >[number];
  }
  const topicalWindow = [
    substrateRow('seed', [1, 0, 0]),
    substrateRow('c1', [1, 0, 0]),
    substrateRow('off1', [0, 1, 0]),
    substrateRow('c2', [0.95, 0.05, 0]),
    substrateRow('off2', [0, 0, 1]),
  ];

  it('mints from the topical cluster and records only its rows as provenance', async () => {
    const { coordinator } = buildCoordinator();
    const mint = vi.fn(async () => ({
      prediction: 'leans into single-topic detail',
      innerVoice: '',
      valence: 0.1,
      confidence: 0.6,
    }));
    const { client, inserted, provRows } = fakeClient('t1-new');
    const supabase = fakeSupabase({
      samskaraRecentEmbeddedSubstrate: vi.fn(async () => topicalWindow),
      samskaraNearestByPrediction: vi.fn(async () => []),
      client,
    } as unknown as Partial<SupabaseService>);
    const agent = fakeAgent({ mint } as unknown as Partial<SamskaraAgent>);
    const ctx = buildCtx({ coordinator, supabase, agent, phase: 'mint-tier1' });
    await runOneCycle(ctx); // acquired-lease
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('progress');
    // The minter saw only the coherent cluster (seed + c1 + c2), not
    // the off-topic neighbours.
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({
        sample_situations: ['situation seed', 'situation c1', 'situation c2'],
      }),
      expect.anything()
    );
    // Provenance is the same coherent set, all weight 1.0 substrate.
    expect(provRows).toHaveLength(1);
    expect(provRows[0].map((r) => r.ref_id)).toEqual(['seed', 'c1', 'c2']);
    expect(provRows[0].every((r) => r.kind === 'substrate' && r.weight === 1.0)).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].tier).toBe(1);
  });

  it('does not mint when the seed has too few topical neighbours', async () => {
    const { coordinator } = buildCoordinator();
    const mint = vi.fn(async () => ({
      prediction: 'should never be asked',
      innerVoice: '',
      valence: 0,
      confidence: 0.5,
    }));
    // Seed plus two orthogonal rows: cluster collapses to the seed
    // alone (1 < MINT_CLUSTER_MIN), so the phase bails before the agent.
    const supabase = fakeSupabase({
      samskaraRecentEmbeddedSubstrate: vi.fn(async () => [
        substrateRow('seed', [1, 0, 0]),
        substrateRow('off1', [0, 1, 0]),
        substrateRow('off2', [0, 0, 1]),
      ]),
    } as unknown as Partial<SupabaseService>);
    const agent = fakeAgent({ mint } as unknown as Partial<SamskaraAgent>);
    const ctx = buildCtx({ coordinator, supabase, agent, phase: 'mint-tier1' });
    await runOneCycle(ctx); // acquired-lease
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-phase');
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('samskara runOneCycle - mint-tier2 phase', () => {
  const candidateGroup = [
    { samskaraId: 's1', prediction: 'pushes back on flowery prose', valence: -0.2, cofireWeight: 8 },
    { samskaraId: 's2', prediction: 'wants code without preamble', valence: 0.1, cofireWeight: 7 },
    { samskaraId: 's3', prediction: 'corrects over-explanation', valence: -0.1, cofireWeight: 6 },
  ];

  it('returns empty-phase when no candidate group is found', async () => {
    const { coordinator } = buildCoordinator();
    const candidate = vi.fn(async () => []);
    const mintTier2 = vi.fn(async () => null);
    const supabase = fakeSupabase({
      samskaraTier2Candidate: candidate,
    } as unknown as Partial<SupabaseService>);
    const agent = fakeAgent({ mintTier2 } as unknown as Partial<SamskaraAgent>);
    const ctx = buildCtx({ coordinator, supabase, agent, phase: 'mint-tier2' });
    await runOneCycle(ctx); // acquired-lease
    const result = await runOneCycle(ctx);
    expect(candidate).toHaveBeenCalled();
    // Agent must not run on a sub-threshold group.
    expect(mintTier2).not.toHaveBeenCalled();
    expect(result).toBe<CycleResult>('empty-phase');
  });

  it('mints a tier-2 row with samskara provenance and fires onMint', async () => {
    const { coordinator } = buildCoordinator();
    const mintTier2 = vi.fn(async () => ({
      confirm: true,
      prediction: 'runs on an efficiency instinct in technical exchanges',
      innerVoice: 'be terse',
      valence: -0.1,
      confidence: 0.5,
    }));
    const { client, inserted, provRows } = fakeClient('t2-abc');
    const supabase = fakeSupabase({
      samskaraTier2Candidate: vi.fn(async () => candidateGroup),
      client,
    } as unknown as Partial<SupabaseService>);
    const agent = fakeAgent({ mintTier2 } as unknown as Partial<SamskaraAgent>);
    const mints: { tier: 1 | 2 }[] = [];
    const ctx = buildCtx({
      coordinator,
      supabase,
      agent,
      phase: 'mint-tier2',
      onMint: (info) => mints.push(info),
    });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('progress');
    // The agent saw the child predictions, stripped of the bookkeeping
    // fields the RPC carries.
    expect(mintTier2).toHaveBeenCalledWith(
      [
        { prediction: 'pushes back on flowery prose', valence: -0.2 },
        { prediction: 'wants code without preamble', valence: 0.1 },
        { prediction: 'corrects over-explanation', valence: -0.1 },
      ],
      expect.anything()
    );
    // tier:2 row inserted.
    expect(inserted).toHaveLength(1);
    expect(inserted[0].tier).toBe(2);
    expect(inserted[0].inner_voice).toBe('be terse');
    // Provenance points at the three children with kind='samskara'.
    expect(provRows).toHaveLength(1);
    expect(provRows[0]).toHaveLength(3);
    expect(provRows[0].every((r) => r.kind === 'samskara')).toBe(true);
    expect(provRows[0].map((r) => r.ref_id)).toEqual(['s1', 's2', 's3']);
    expect(provRows[0].map((r) => r.weight)).toEqual([8, 7, 6]);
    // onMint fired with tier 2.
    expect(mints).toEqual([{ tier: 2, valence: -0.1, confidence: 0.5 }]);
  });

  it('returns empty-phase without inserting when the agent declines', async () => {
    const { coordinator } = buildCoordinator();
    const mintTier2 = vi.fn(async () => null);
    const { client, inserted } = fakeClient();
    const supabase = fakeSupabase({
      samskaraTier2Candidate: vi.fn(async () => candidateGroup),
      client,
    } as unknown as Partial<SupabaseService>);
    const agent = fakeAgent({ mintTier2 } as unknown as Partial<SamskaraAgent>);
    const ctx = buildCtx({ coordinator, supabase, agent, phase: 'mint-tier2' });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(mintTier2).toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(result).toBe<CycleResult>('empty-phase');
  });

  it('reinforces an existing compound instead of minting a twin on a dedup hit', async () => {
    const { coordinator } = buildCoordinator();
    const mintTier2 = vi.fn(async () => ({
      confirm: true,
      prediction: 'efficiency instinct',
      innerVoice: '',
      valence: 0,
      confidence: 0.5,
    }));
    const nearest = vi.fn(async () => [{ id: 't2-existing', cosine: 0.92, tier: 2 }]);
    const reinforce = vi.fn(async () => true);
    const { client, inserted } = fakeClient();
    const supabase = fakeSupabase({
      samskaraTier2Candidate: vi.fn(async () => candidateGroup),
      samskaraNearestByPrediction: nearest,
      samskaraReinforceExisting: reinforce,
      client,
    } as unknown as Partial<SupabaseService>);
    const agent = fakeAgent({ mintTier2 } as unknown as Partial<SamskaraAgent>);
    const mints: { tier: 1 | 2 }[] = [];
    const ctx = buildCtx({
      coordinator,
      supabase,
      agent,
      phase: 'mint-tier2',
      onMint: (info) => mints.push(info),
    });
    await runOneCycle(ctx);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('progress');
    // Dedup query was tier-scoped to compounds.
    expect(nearest).toHaveBeenCalledWith(expect.anything(), 1, 2);
    // Reinforced health only - reinforce never writes provenance.
    expect(reinforce).toHaveBeenCalledWith('t2-existing', expect.any(Number));
    // No new row, no mint toast.
    expect(inserted).toHaveLength(0);
    expect(mints).toEqual([]);
  });

  it('skips entirely when throttled - no candidate RPC fires', async () => {
    const { coordinator } = buildCoordinator();
    const candidate = vi.fn(async () => candidateGroup);
    const supabase = fakeSupabase({
      samskaraTier2Candidate: candidate,
    } as unknown as Partial<SupabaseService>);
    const ctx = buildCtx({
      coordinator,
      supabase,
      phase: 'mint-tier2',
      phaseThrottle: {
        lastRunMs: new Map([['mint-tier2', Date.now()]]),
        minIntervalMs: 60_000,
        intervalOverridesMs: { 'mint-tier2': 5 * 60 * 1000 },
      },
    });
    await runOneCycle(ctx); // acquired-lease
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-phase');
    expect(candidate).not.toHaveBeenCalled();
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
