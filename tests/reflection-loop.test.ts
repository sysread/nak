/**
 * Unit coverage for the reflection worker's cycle driver. The driver
 * is a state machine over (lease held?, thread claimed?, agent
 * run?, mark succeeded?). We exercise each transition directly via
 * runOneCycle — the worker entry point in worker.ts is a thin
 * wrapper around this and needs a Web Worker runtime to test, so
 * the real behavioural coverage is here.
 *
 * The agent itself is mocked — we're testing the cycle, not the
 * reflection LLM. A canned AgentRunResult drives each branch; the
 * ReflectionAgent's own unit tests cover its run() internals.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runOneCycle,
  napForResult,
  type CycleContext,
  type CycleResult,
  type NapConfig,
} from '../src/lib/agents/reflection/loop';
import { LeaseCoordinator, type LeaseTimers } from '../src/lib/embeddings/lease';
import type { SupabaseService } from '../src/lib/supabase';
import type {
  Agent,
  AgentRunRequest,
  AgentRunResult,
  AgentStoppedReason,
} from '../src/lib/agents/types';
import type {
  ReflectionInput,
  ReflectionOutput,
} from '../src/lib/agents/reflection/agent';
import { memoryToolbox } from '../src/lib/tools';

/**
 * Build a real LeaseCoordinator over a mocked SupabaseService so
 * cycles that touch the lease test the real coordinator, not a test
 * double of it.
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
    'reflection',
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

/**
 * Build a SupabaseService stub with the three reflection-related
 * methods. Each defaults to a reasonable happy-path behaviour; tests
 * override per-call with mockResolvedValueOnce / mockRejectedValueOnce.
 */
function makeSupabase(): {
  svc: SupabaseService;
  spies: {
    claimNextThreadForReflection: ReturnType<typeof vi.fn>;
    markThreadReflectedIfClaimed: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    claimNextThreadForReflection: vi.fn(async () => null),
    markThreadReflectedIfClaimed: vi.fn(async () => true),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

/**
 * Mock agent. `run` is a vi.fn returning the canned result by
 * default; tests override per-call. Advertises the real
 * memoryToolbox so the identity fields are plausible without
 * pulling in the VeniceClient / SupabaseService a real
 * ReflectionAgent needs.
 */
function makeAgent(
  run: (
    req: AgentRunRequest<ReflectionInput>
  ) => Promise<AgentRunResult<ReflectionOutput>> = async () => ({
    output: { finalText: 'ok', inputMessageCount: 5 },
    toolCalls: 0,
    stoppedReason: 'done' as AgentStoppedReason,
  })
): { agent: Agent<ReflectionInput, ReflectionOutput>; runSpy: ReturnType<typeof vi.fn> } {
  const runSpy = vi.fn(run);
  const agent: Agent<ReflectionInput, ReflectionOutput> = {
    name: 'reflection',
    model: 'test-model',
    toolbox: memoryToolbox,
    run: runSpy,
  };
  return { agent, runSpy };
}

function buildCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  const { coordinator } = buildCoordinator();
  const { svc } = makeSupabase();
  const { agent } = makeAgent();
  return {
    agent,
    supabase: svc,
    coordinator,
    holderId: 'holder-test',
    userId: 'u',
    threadClaimTtlSeconds: 600,
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

  it('does NOT claim a thread on the lease-acquisition cycle — defers to the next', async () => {
    const { coordinator } = buildCoordinator();
    const { svc, spies: svcSpies } = makeSupabase();
    const ctx = buildCtx({ coordinator, supabase: svc });
    await runOneCycle(ctx);
    expect(svcSpies.claimNextThreadForReflection).not.toHaveBeenCalled();
  });

  it('invokes onLeaseLost when a subsequent heartbeat fails', async () => {
    const { coordinator, leaseSpies, fireHeartbeat } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const onLeaseLost = vi.fn();
    const ctx = buildCtx({ coordinator, onLeaseLost });
    await runOneCycle(ctx);
    leaseSpies.heartbeatWorkerLease.mockResolvedValueOnce(false);
    await fireHeartbeat();
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(coordinator.isHolding).toBe(false);
  });
});

describe('runOneCycle — holding lease, work path', () => {
  async function holdLease(ctx: CycleContext) {
    const result = await runOneCycle(ctx);
    expect(result).toBe<CycleResult>('acquired-lease');
  }

  it('empty queue returns empty-queue without invoking the agent', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { svc, spies: svcSpies } = makeSupabase();
    const { agent, runSpy } = makeAgent();
    svcSpies.claimNextThreadForReflection.mockResolvedValue(null);

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('empty-queue');
    expect(svcSpies.claimNextThreadForReflection).toHaveBeenCalledWith('holder-test', 600);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('happy path: claim → agent.run (done) → mark → reflected', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { svc, spies: svcSpies } = makeSupabase();
    svcSpies.claimNextThreadForReflection.mockResolvedValueOnce({
      threadId: 't-42',
      terminalMsgId: 'a-99',
    });
    const { agent, runSpy } = makeAgent();

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('reflected');
    expect(runSpy).toHaveBeenCalledOnce();
    // Agent receives both threadId inside input AND alongside it on
    // the request; the tool ctx later in the chain needs it either
    // way. Assert explicitly to catch a future refactor that drops
    // one.
    const [[req]] = runSpy.mock.calls;
    expect(req.input.threadId).toBe('t-42');
    expect(req.input.terminalMsgId).toBe('a-99');
    expect(req.threadId).toBe('t-42');
    expect(req.userId).toBe('u');
    // Mark stamps the exact terminalMsgId we claimed against.
    expect(svcSpies.markThreadReflectedIfClaimed).toHaveBeenCalledWith(
      't-42',
      'holder-test',
      'a-99'
    );
  });

  it('claim-lost when the mark RPC returns false — agent side effects stay', async () => {
    // Another device took over mid-reflection. Any memory writes the
    // agent already made are owned by the user, not the claim, so
    // they survive. We just don't advance last_reflected_msg_id;
    // device B will redo.
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { svc, spies: svcSpies } = makeSupabase();
    svcSpies.claimNextThreadForReflection.mockResolvedValueOnce({
      threadId: 't-1',
      terminalMsgId: 'a-1',
    });
    svcSpies.markThreadReflectedIfClaimed.mockResolvedValueOnce(false);
    const { agent } = makeAgent();

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('claim-lost');
  });

  it('error when claimNext itself throws', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { svc, spies: svcSpies } = makeSupabase();
    svcSpies.claimNextThreadForReflection.mockRejectedValueOnce(new Error('network'));
    const { agent, runSpy } = makeAgent();

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('error when the mark RPC throws — unknown whether the update landed', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { svc, spies: svcSpies } = makeSupabase();
    svcSpies.claimNextThreadForReflection.mockResolvedValueOnce({
      threadId: 't-1',
      terminalMsgId: 'a-1',
    });
    svcSpies.markThreadReflectedIfClaimed.mockRejectedValueOnce(new Error('boom'));
    const { agent } = makeAgent();

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
  });

  it('error when agent.run returns stoppedReason=error', async () => {
    // Re-reflection on the same thread is safe (memory_search finds
    // already-written memories), so we don't mark — leave the
    // pointer alone and let the next cycle retry.
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { svc, spies: svcSpies } = makeSupabase();
    svcSpies.claimNextThreadForReflection.mockResolvedValueOnce({
      threadId: 't-1',
      terminalMsgId: 'a-1',
    });
    const { agent } = makeAgent(async () => ({
      output: { finalText: '', inputMessageCount: 0 },
      toolCalls: 0,
      stoppedReason: 'error' as AgentStoppedReason,
      error: 'venice 500',
    }));

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
    expect(svcSpies.markThreadReflectedIfClaimed).not.toHaveBeenCalled();
  });

  it('empty-queue on agent.run stoppedReason=aborted — caller is shutting down', async () => {
    // We treat an aborted run the same as an empty queue: the outer
    // loop will notice signal.aborted on the next iteration and
    // exit. Don't mark — the run didn't complete, the TTL will
    // sweep the claim.
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { svc, spies: svcSpies } = makeSupabase();
    svcSpies.claimNextThreadForReflection.mockResolvedValueOnce({
      threadId: 't-1',
      terminalMsgId: 'a-1',
    });
    const { agent } = makeAgent(async () => ({
      output: { finalText: '', inputMessageCount: 0 },
      toolCalls: 0,
      stoppedReason: 'aborted' as AgentStoppedReason,
    }));

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('empty-queue');
    expect(svcSpies.markThreadReflectedIfClaimed).not.toHaveBeenCalled();
  });

  it('error when agent.run itself throws (defensive — the agent should catch its own)', async () => {
    const { coordinator, leaseSpies } = buildCoordinator();
    leaseSpies.acquireWorkerLease.mockResolvedValueOnce(true);
    const { svc, spies: svcSpies } = makeSupabase();
    svcSpies.claimNextThreadForReflection.mockResolvedValueOnce({
      threadId: 't-1',
      terminalMsgId: 'a-1',
    });
    const { agent } = makeAgent(async () => {
      throw new Error('unexpected escape');
    });

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
    expect(svcSpies.markThreadReflectedIfClaimed).not.toHaveBeenCalled();
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
    idleIntervalMs: 30_000,
    errorBackoffMs: 10_000,
  };

  it('drains fast on forward-progress results', () => {
    expect(napForResult('acquired-lease', config)).toBe(0);
    expect(napForResult('reflected', config)).toBe(0);
    expect(napForResult('claim-lost', config)).toBe(0);
  });

  it('polls at the lease cadence when contended', () => {
    expect(napForResult('polling', config)).toBe(20_000);
  });

  it('idles on empty queue at the 30s cadence', () => {
    expect(napForResult('empty-queue', config)).toBe(30_000);
  });

  it('backs off on transient error', () => {
    expect(napForResult('error', config)).toBe(10_000);
  });
});
