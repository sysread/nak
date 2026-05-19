/**
 * Coverage for the wiki worker's failure-handling branch. The cycle's
 * happy path mirrors reflection-loop.test.ts and is exercised
 * implicitly via the integration tests; this file focuses on the
 * branch that differs: when the agent reports an error, the loop
 * calls record_wiki_failure_or_skip and the result decides whether
 * we surface a 'released' retry, a 'skipped' give-up, or a 'claim-lost'
 * race. See loop.ts for the policy this verifies.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runOneCycle,
  type CycleContext,
  type CycleResult,
} from '../src/lib/agents/wiki/loop';
import { LeaseCoordinator, type LeaseTimers } from '../src/lib/embeddings/lease';
import type { SupabaseService } from '../src/lib/supabase';
import type {
  Agent,
  AgentRunRequest,
  AgentRunResult,
  AgentStoppedReason,
} from '../src/lib/agents/types';
import type { WikiInput, WikiOutput } from '../src/lib/agents/wiki/types';
import { wikiToolbox } from '../src/lib/tools/wiki_toolbox';

function buildCoordinator(): { coordinator: LeaseCoordinator } {
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
    'wiki',
    'holder-test',
    { ttlSeconds: 45, heartbeatMs: 20_000 },
    timers
  );
  return { coordinator };
}

function makeSupabase(): {
  svc: SupabaseService;
  spies: {
    claimNextThreadForWiki: ReturnType<typeof vi.fn>;
    markThreadWikiProcessedIfClaimed: ReturnType<typeof vi.fn>;
    recordWikiFailureOrSkip: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    claimNextThreadForWiki: vi.fn(async () => null),
    markThreadWikiProcessedIfClaimed: vi.fn(async () => true),
    recordWikiFailureOrSkip: vi.fn(async () => 'released' as const),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

function makeAgent(
  run: (
    req: AgentRunRequest<WikiInput>
  ) => Promise<AgentRunResult<WikiOutput>> = async () => ({
    output: { finalText: 'ok', inputMessageCount: 5 },
    toolCalls: 0,
    stoppedReason: 'done' as AgentStoppedReason,
  })
): { agent: Agent<WikiInput, WikiOutput> } {
  const agent: Agent<WikiInput, WikiOutput> = {
    name: 'wiki',
    model: 'test-model',
    toolbox: wikiToolbox,
    run: vi.fn(run),
  };
  return { agent };
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
    timezone: 'UTC',
    threadClaimTtlSeconds: 600,
    maxFailuresPerThread: 3,
    signal: new AbortController().signal,
    onLeaseLost: () => {},
    ...overrides,
  };
}

async function holdLease(ctx: CycleContext) {
  const result = await runOneCycle(ctx);
  expect(result).toBe<CycleResult>('acquired-lease');
}

describe('runOneCycle wiki - error path', () => {
  it('records failure as "released" and surfaces error - retry budget intact', async () => {
    const { coordinator } = buildCoordinator();
    const { svc, spies } = makeSupabase();
    spies.claimNextThreadForWiki.mockResolvedValueOnce({
      threadId: 't-1',
      terminalMsgId: 'a-1',
      title: 'Demo',
      newestMsgAt: '2026-05-19T00:00:00Z',
    });
    spies.recordWikiFailureOrSkip.mockResolvedValueOnce('released');
    const { agent } = makeAgent(async () => ({
      output: { finalText: '', inputMessageCount: 0 },
      toolCalls: 0,
      stoppedReason: 'error' as AgentStoppedReason,
      error: 'Venice HTTP 400: filter',
    }));

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
    expect(spies.recordWikiFailureOrSkip).toHaveBeenCalledWith(
      't-1',
      'holder-test',
      'a-1',
      3,
      'Venice HTTP 400: filter'
    );
    expect(spies.markThreadWikiProcessedIfClaimed).not.toHaveBeenCalled();
  });

  it('records failure as "skipped" and returns skipped - pointer advanced by the RPC', async () => {
    const { coordinator } = buildCoordinator();
    const { svc, spies } = makeSupabase();
    spies.claimNextThreadForWiki.mockResolvedValueOnce({
      threadId: 't-2',
      terminalMsgId: 'a-2',
      title: 'Filtered',
      newestMsgAt: '2026-05-19T00:00:00Z',
    });
    spies.recordWikiFailureOrSkip.mockResolvedValueOnce('skipped');
    const { agent } = makeAgent(async () => ({
      output: { finalText: '', inputMessageCount: 0 },
      toolCalls: 0,
      stoppedReason: 'error' as AgentStoppedReason,
      error: 'Venice HTTP 400: filter',
    }));

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('skipped');
    // The driver does NOT call mark in addition to the failure RPC -
    // the RPC handled the pointer advance atomically.
    expect(spies.markThreadWikiProcessedIfClaimed).not.toHaveBeenCalled();
  });

  it('records failure as "claim-lost" when the claim is no longer ours', async () => {
    const { coordinator } = buildCoordinator();
    const { svc, spies } = makeSupabase();
    spies.claimNextThreadForWiki.mockResolvedValueOnce({
      threadId: 't-3',
      terminalMsgId: 'a-3',
      title: null,
      newestMsgAt: '2026-05-19T00:00:00Z',
    });
    spies.recordWikiFailureOrSkip.mockResolvedValueOnce('claim-lost');
    const { agent } = makeAgent(async () => ({
      output: { finalText: '', inputMessageCount: 0 },
      toolCalls: 0,
      stoppedReason: 'error' as AgentStoppedReason,
      error: 'Venice HTTP 500',
    }));

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('claim-lost');
  });

  it('falls back to "error" when the failure RPC itself throws - the claim TTL will sweep the row', async () => {
    const { coordinator } = buildCoordinator();
    const { svc, spies } = makeSupabase();
    spies.claimNextThreadForWiki.mockResolvedValueOnce({
      threadId: 't-4',
      terminalMsgId: 'a-4',
      title: null,
      newestMsgAt: '2026-05-19T00:00:00Z',
    });
    spies.recordWikiFailureOrSkip.mockRejectedValueOnce(new Error('rpc boom'));
    const { agent } = makeAgent(async () => ({
      output: { finalText: '', inputMessageCount: 0 },
      toolCalls: 0,
      stoppedReason: 'error' as AgentStoppedReason,
      error: 'Venice HTTP 400',
    }));

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('error');
    expect(spies.markThreadWikiProcessedIfClaimed).not.toHaveBeenCalled();
  });
});

describe('runOneCycle wiki - happy path stays intact', () => {
  it('claims, runs, marks processed when the agent reports done', async () => {
    const { coordinator } = buildCoordinator();
    const { svc, spies } = makeSupabase();
    spies.claimNextThreadForWiki.mockResolvedValueOnce({
      threadId: 't-ok',
      terminalMsgId: 'a-ok',
      title: 'Good run',
      newestMsgAt: '2026-05-19T00:00:00Z',
    });
    const { agent } = makeAgent();

    const ctx = buildCtx({ coordinator, supabase: svc, agent });
    await holdLease(ctx);
    const result = await runOneCycle(ctx);

    expect(result).toBe<CycleResult>('processed');
    expect(spies.markThreadWikiProcessedIfClaimed).toHaveBeenCalledWith(
      't-ok',
      'holder-test',
      'a-ok'
    );
    expect(spies.recordWikiFailureOrSkip).not.toHaveBeenCalled();
  });
});
