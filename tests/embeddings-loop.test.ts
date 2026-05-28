/**
 * Unit coverage for the embeddings worker cycle driver. The driver is a
 * state machine over (lease held?, row claimed?, embed succeeded?,
 * save succeeded?). We exercise each transition directly via
 * runOneCycle — the worker entry point in worker.ts is a thin wrapper
 * around this and needs a Web Worker runtime to test, so the real
 * behavioural coverage is here.
 *
 * Why not integration-test the whole worker against a real Supabase?
 * The cycle results are deterministic functions of the injected RPCs;
 * mocking at the source/embed seam keeps the tests fast and keeps
 * failures pointing at the loop logic rather than someone else's
 * flakiness.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runOneCycle,
  napForResult,
  sleep,
  type CycleContext,
  type CycleResult,
  type NapConfig,
} from '../src/lib/embeddings/loop';
import { LeaseCoordinator, type LeaseTimers } from '../src/lib/embeddings/lease';
import { VeniceError } from '../src/lib/venice';
import type { SupabaseService } from '../src/lib/supabase';
import type { EmbeddingSource, PendingItem } from '../src/lib/embeddings/types';
import { EMBEDDING_STORAGE_DIMS, VENICE_EMBEDDING_DIMS } from '../src/lib/models';

/**
 * Build a real LeaseCoordinator over a mocked SupabaseService so cycles
 * that touch the lease (acquire / heartbeat wiring) test the real
 * coordinator, not a test double of it.
 */
function buildCoordinator(): {
  coordinator: LeaseCoordinator;
  leaseSpies: {
    acquireWorkerLease: ReturnType<typeof vi.fn>;
    heartbeatWorkerLease: ReturnType<typeof vi.fn>;
    releaseWorkerLease: ReturnType<typeof vi.fn>;
  };
  fireHeartbeat: () => Promise<void>;
} {
  const leaseSpies = {
    acquireWorkerLease: vi.fn(async () => true),
    heartbeatWorkerLease: vi.fn(async () => true),
    releaseWorkerLease: vi.fn(async () => undefined),
  };
  let captured: (() => void) | null = null;
  const handle = Symbol('h') as unknown as ReturnType<typeof setInterval>;
  const timers: LeaseTimers = {
    setInterval: (fn: () => void) => {
      captured = fn;
      return handle;
    },
    clearInterval: () => {
      captured = null;
    },
  };
  const coordinator = new LeaseCoordinator(
    leaseSpies as unknown as SupabaseService,
    'embedding',
    'holder-test',
    { ttlSeconds: 45, heartbeatMs: 20_000 },
    timers
  );
  return {
    coordinator,
    leaseSpies,
    async fireHeartbeat() {
      if (!captured) throw new Error('no heartbeat interval armed');
      captured();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function makeSource(
  overrides: Partial<EmbeddingSource> = {}
): { source: EmbeddingSource; spies: { claimNext: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } } {
  const spies = {
    claimNext: vi.fn(async (): Promise<PendingItem | null> => null),
    save: vi.fn(async () => true),
  };
  const source: EmbeddingSource = {
    name: 'memories',
    claimNext: spies.claimNext,
    save: spies.save,
    ...overrides,
  };
  return { source, spies };
}

/** Mock embedder returning a deterministic 1024-dim embedding. */
function makeEmbedder(): { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async () =>
    Array.from({ length: VENICE_EMBEDDING_DIMS }, (_, i) => i * 0.0001)
  );
  return { embed };
}

function buildCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  const { coordinator } = buildCoordinator();
  const { source } = makeSource();
  const { embed } = makeEmbedder();
  return {
    source,
    embed,
    coordinator,
    holderId: 'holder-test',
    embeddingModel: 'bge-m3',
    rowClaimTtlSeconds: 120,
    signal: new AbortController().signal,
    onLeaseLost: () => {},
    ...overrides,
  };
}

describe('runOneCycle — lease acquisition', () => {
  it('returns polling when the acquire RPC denies the lease', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(false);
    const ctx = buildCtx({ coordinator });
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('polling');
    expect(coordinator.isHolding).toBe(false);
  });

  it('returns acquired-lease and flips isHolding on successful acquire', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const ctx = buildCtx({ coordinator });
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('acquired-lease');
    expect(coordinator.isHolding).toBe(true);
  });

  it('does NOT claim a row on the lease-acquisition cycle — it defers to the next cycle', async () => {
    const { coordinator } = buildCoordinator();
    const { source, spies: sourceSpies } = makeSource();
    const ctx = buildCtx({ coordinator, source });
    await runOneCycle(ctx);
    expect(sourceSpies.claimNext).not.toHaveBeenCalled();
  });

  it('invokes onLeaseLost when a subsequent heartbeat fails', async () => {
    const { coordinator, leaseSpies, fireHeartbeat } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const onLeaseLost = vi.fn();
    const ctx = buildCtx({ coordinator, onLeaseLost });
    await runOneCycle(ctx);
    // Next heartbeat says "you lost it".
    leaseSpies.heartbeatWorkerLease.mockResolvedValueOnce(false);
    await fireHeartbeat();
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(coordinator.isHolding).toBe(false);
  });

  it('after a lease loss, the next runOneCycle falls back into polling', async () => {
    const { coordinator, leaseSpies, fireHeartbeat } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const ctx = buildCtx({ coordinator });
    await runOneCycle(ctx); // acquired-lease

    leaseSpies.heartbeatWorkerLease.mockResolvedValueOnce(false);
    await fireHeartbeat();

    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(false);
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('polling');
  });
});

describe('runOneCycle — holding lease, work path', () => {
  async function holdLease(ctx: CycleContext) {
    // Prime isHolding by running one cycle with acquire → true.
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('acquired-lease');
  }

  it('empty queue returns empty-queue without touching Venice', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    const { embed } = makeEmbedder();
    sourceSpies.claimNext.mockResolvedValue(null);

    const ctx = buildCtx({ coordinator, source, embed });
    await holdLease(ctx);

    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-queue');
    expect(sourceSpies.claimNext).toHaveBeenCalledWith('holder-test', 120);
    expect(embed).not.toHaveBeenCalled();
  });

  it('happy path: claim → embed → pad to storage dim → save → embedded', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    const { embed } = makeEmbedder();
    sourceSpies.claimNext.mockResolvedValueOnce({ id: 'm-1', input: 'hello world' });

    const ctx = buildCtx({ coordinator, source, embed });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('embedded');
    expect(embed).toHaveBeenCalledWith('hello world', expect.anything());
    // Saved embedding must be the storage dim, padded from the 1024
    // Venice gave us. That's the critical invariant — a mismatched dim
    // would error at the pgvector boundary.
    expect(sourceSpies.save).toHaveBeenCalledOnce();
    const [savedId, savedHolder, savedEmbedding, savedModel] = sourceSpies.save.mock.calls[0];
    expect(savedId).toBe('m-1');
    expect(savedHolder).toBe('holder-test');
    expect(savedEmbedding).toHaveLength(EMBEDDING_STORAGE_DIMS);
    // Prefix comes from Venice; suffix is zero-padded.
    expect(savedEmbedding.slice(VENICE_EMBEDDING_DIMS).every((v: number) => v === 0)).toBe(true);
    expect(savedModel).toBe('bge-m3');
  });

  it('save-rejected when the claim guard returns false (row edited or TTL expired)', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    const { embed } = makeEmbedder();
    sourceSpies.claimNext.mockResolvedValueOnce({ id: 'm-2', input: 'x' });
    sourceSpies.save.mockResolvedValueOnce(false);

    const ctx = buildCtx({ coordinator, source, embed });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('save-rejected');
  });

  it('no-embedding when Venice returns empty data (rare protocol edge)', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    const embed = vi.fn(async () => undefined);
    sourceSpies.claimNext.mockResolvedValueOnce({ id: 'm-3', input: 'x' });

    const ctx = buildCtx({ coordinator, source, embed });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('no-embedding');
    expect(sourceSpies.save).not.toHaveBeenCalled();
  });

  it('rate-limited when Venice throws VeniceError(kind=rate_limit)', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    const embed = vi.fn(async () => {
      throw new VeniceError('429', 'rate_limit');
    });
    sourceSpies.claimNext.mockResolvedValueOnce({ id: 'm-4', input: 'x' });

    const ctx = buildCtx({ coordinator, source, embed });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('rate-limited');
    expect(sourceSpies.save).not.toHaveBeenCalled();
  });

  it('error when Venice throws a non-rate-limit VeniceError', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    const embed = vi.fn(async () => {
      throw new VeniceError('500', 'http');
    });
    sourceSpies.claimNext.mockResolvedValueOnce({ id: 'm-5', input: 'x' });

    const ctx = buildCtx({ coordinator, source, embed });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
  });

  it('error when claimNext itself throws — row stays unclaimed for next cycle', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    sourceSpies.claimNext.mockRejectedValueOnce(new Error('network'));
    const { embed } = makeEmbedder();

    const ctx = buildCtx({ coordinator, source, embed });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
    expect(embed).not.toHaveBeenCalled();
  });

  it('error when save itself throws — treats like transient failure', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    sourceSpies.claimNext.mockResolvedValueOnce({ id: 'm-6', input: 'x' });
    sourceSpies.save.mockRejectedValueOnce(new Error('network'));
    const { embed } = makeEmbedder();

    const ctx = buildCtx({ coordinator, source, embed });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
  });

  it('threads the AbortSignal through to the embedder so stop cancels in-flight embeds', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { source, spies: sourceSpies } = makeSource();
    const { embed } = makeEmbedder();
    sourceSpies.claimNext.mockResolvedValueOnce({ id: 'm-7', input: 'x' });

    const ac = new AbortController();
    const ctx = buildCtx({ coordinator, source, embed, signal: ac.signal });
    await holdLease(ctx);
    await runOneCycle(ctx);

    expect(embed).toHaveBeenCalledWith('x', ac.signal);
  });
});

describe('runOneCycle — abort', () => {
  it('short-circuits an already-aborted signal as empty-queue (caller exits loop)', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = buildCtx({ signal: ac.signal });
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('empty-queue');
  });
});

describe('napForResult', () => {
  const config: NapConfig = {
    leasePollMs: 20_000,
    idleIntervalMs: 5_000,
    errorBackoffMs: 5_000,
    rateLimitBackoffMs: 30_000,
  };

  it('drains fast on forward-progress results', () => {
    expect(napForResult('acquired-lease', config)).toBe(0);
    expect(napForResult('embedded', config)).toBe(0);
    expect(napForResult('save-rejected', config)).toBe(0);
    expect(napForResult('no-embedding', config)).toBe(0);
  });

  it('polls at the lease cadence when contended', () => {
    expect(napForResult('polling', config)).toBe(20_000);
  });

  it('idles on empty queue at the fast-drain cadence', () => {
    expect(napForResult('empty-queue', config)).toBe(5_000);
  });

  it('short back-off on transient error', () => {
    expect(napForResult('error', config)).toBe(5_000);
  });

  it('long back-off on rate limit — longer than generic error', () => {
    expect(napForResult('rate-limited', config)).toBeGreaterThan(
      napForResult('error', config)
    );
    expect(napForResult('rate-limited', config)).toBe(30_000);
  });
});

describe('sleep', () => {
  it('resolves immediately for 0 ms (no timer allocated)', async () => {
    const t0 = Date.now();
    await sleep(0, new AbortController().signal);
    expect(Date.now() - t0).toBeLessThan(20);
  });

  it('resolves when the signal aborts before the timeout', async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    setTimeout(() => ac.abort(), 5);
    const t0 = Date.now();
    await p;
    // Should have resolved near the abort, not near the full 10s.
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('resolves naturally when the timeout elapses with no abort', async () => {
    const t0 = Date.now();
    await sleep(10, new AbortController().signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9);
  });
});
