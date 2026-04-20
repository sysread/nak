/**
 * Unit coverage for the attachment-expiry worker's cycle driver.
 * Mirrors tests/reflection-loop.test.ts in shape but the state
 * machine is smaller: there's no per-row claim and no agent. We
 * exercise the four cycle transitions — polling, acquired-lease,
 * empty-queue, expired, error — by driving runOneCycle with a mock
 * SupabaseService.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runOneCycle,
  napForResult,
  type CycleContext,
  type CycleResult,
  type NapConfig,
} from '../src/lib/agents/attachment_expiry/loop';
import { LeaseCoordinator, type LeaseTimers } from '../src/lib/embeddings/lease';
import type { SupabaseService } from '../src/lib/supabase';

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
    'attachment_expiry',
    'holder-test',
    { ttlSeconds: 45, heartbeatMs: 20_000 },
    timers
  );
  return { coordinator, leaseSpies };
}

function makeSupabase(): {
  svc: SupabaseService;
  spies: { expireOldAttachments: ReturnType<typeof vi.fn> };
} {
  const spies = {
    expireOldAttachments: vi.fn(async () => 0),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

function buildCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  const { coordinator } = buildCoordinator();
  const { svc } = makeSupabase();
  return {
    supabase: svc,
    coordinator,
    expiryDays: 30,
    signal: new AbortController().signal,
    onLeaseLost: () => {},
    ...overrides,
  };
}

describe('attachment-expiry runOneCycle', () => {
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

  it('returns empty-queue when the RPC returns zero', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    await runOneCycle(buildCtx({ coordinator }));
    const { svc, spies } = makeSupabase();
    spies.expireOldAttachments.mockResolvedValueOnce(0);
    const result = await runOneCycle(buildCtx({ coordinator, supabase: svc }));
    expect(result).toBe<CycleResult>('empty-queue');
    expect(spies.expireOldAttachments).toHaveBeenCalledWith(30);
  });

  it('returns expired when the RPC returns a positive count', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    await runOneCycle(buildCtx({ coordinator }));
    const { svc, spies } = makeSupabase();
    spies.expireOldAttachments.mockResolvedValueOnce(7);
    const result = await runOneCycle(buildCtx({ coordinator, supabase: svc }));
    expect(result).toBe<CycleResult>('expired');
  });

  it('returns error when the RPC throws', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    await runOneCycle(buildCtx({ coordinator }));
    const { svc, spies } = makeSupabase();
    spies.expireOldAttachments.mockRejectedValueOnce(new Error('boom'));
    const result = await runOneCycle(buildCtx({ coordinator, supabase: svc }));
    expect(result).toBe<CycleResult>('error');
  });

  it('short-circuits empty-queue when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { svc, spies } = makeSupabase();
    const result = await runOneCycle(buildCtx({ signal: ac.signal, supabase: svc }));
    expect(result).toBe<CycleResult>('empty-queue');
    expect(spies.expireOldAttachments).not.toHaveBeenCalled();
  });
});

describe('napForResult', () => {
  const config: NapConfig = {
    leasePollMs: 20_000,
    idleIntervalMs: 60 * 60 * 1000,
    errorBackoffMs: 60_000,
  };

  it('naps zero on acquired-lease and expired — to drain', () => {
    expect(napForResult('acquired-lease', config)).toBe(0);
    expect(napForResult('expired', config)).toBe(0);
  });

  it('naps lease-poll on polling', () => {
    expect(napForResult('polling', config)).toBe(20_000);
  });

  it('naps the idle interval on empty-queue', () => {
    expect(napForResult('empty-queue', config)).toBe(60 * 60 * 1000);
  });

  it('naps error back-off on error', () => {
    expect(napForResult('error', config)).toBe(60_000);
  });
});
