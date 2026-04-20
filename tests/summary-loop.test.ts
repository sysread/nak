/**
 * Coverage for the summary worker's single-cycle state machine.
 * Mirrors `reflection-loop.test.ts` — the interesting transitions are
 * lease acquire/polling, empty queue, successful save, claim-lost on
 * stale save, empty-summary skip, and error back-off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOneCycle, type CycleContext } from '../src/lib/agents/summary/loop';
import type { Agent } from '../src/lib/agents/types';
import type {
  SummaryInput,
  SummaryOutput,
} from '../src/lib/agents/summary/agent';
import type { SupabaseService } from '../src/lib/supabase';
import type { LeaseCoordinator } from '../src/lib/embeddings/lease';

type ClaimShape = { threadId: string; terminalMsgId: string } | null;

function makeAgent(
  summary: string,
  reason: 'done' | 'aborted' | 'error' = 'done'
): Agent<SummaryInput, SummaryOutput> {
  return {
    name: 'summary',
    model: 'fast-model',
    toolbox: { name: 'summary', description: 'stub', tools: [] },
    run: vi.fn(async () => ({
      output: { summary, inputMessageCount: 3 },
      toolCalls: 0,
      stoppedReason: reason,
    })),
  };
}

function makeCtx(opts: {
  agent: Agent<SummaryInput, SummaryOutput>;
  isHolding: boolean;
  acquire?: () => Promise<boolean>;
  claim?: ClaimShape;
  claimThrows?: boolean;
  save?: (t: string, h: string, s: string, m: string) => Promise<boolean>;
  saveThrows?: boolean;
  signal?: AbortSignal;
}): CycleContext {
  const coordinator = {
    isHolding: opts.isHolding,
    acquire: opts.acquire ?? (async () => true),
    startHeartbeat: vi.fn(),
    release: vi.fn(async () => {}),
  } as unknown as LeaseCoordinator;

  const supabase = {
    claimNextThreadForSummary: vi.fn(async () => {
      if (opts.claimThrows) throw new Error('boom');
      return opts.claim ?? null;
    }),
    saveThreadSummaryIfClaimed: vi.fn(async (t: string, h: string, s: string, m: string) => {
      if (opts.saveThrows) throw new Error('boom');
      return (opts.save ?? (async () => true))(t, h, s, m);
    }),
  } as unknown as SupabaseService;

  return {
    agent: opts.agent,
    supabase,
    coordinator,
    holderId: 'h-1',
    userId: 'u-1',
    threadClaimTtlSeconds: 120,
    signal: opts.signal ?? new AbortController().signal,
    onLeaseLost: vi.fn(),
  };
}

describe('runOneCycle', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('returns empty-queue when the signal is already aborted', async () => {
    const agent = makeAgent('');
    const ctl = new AbortController();
    ctl.abort();
    const ctx = makeCtx({ agent, isHolding: true, signal: ctl.signal });
    const result = await runOneCycle(ctx);
    expect(result).toBe('empty-queue');
  });

  it('polls when the lease can\'t be acquired', async () => {
    const agent = makeAgent('');
    const ctx = makeCtx({ agent, isHolding: false, acquire: async () => false });
    expect(await runOneCycle(ctx)).toBe('polling');
  });

  it('reports acquired-lease on the cycle we first take the lock', async () => {
    const agent = makeAgent('');
    const ctx = makeCtx({ agent, isHolding: false, acquire: async () => true });
    expect(await runOneCycle(ctx)).toBe('acquired-lease');
    expect(ctx.coordinator.startHeartbeat).toHaveBeenCalled();
  });

  it('returns empty-queue when the claim RPC has nothing to hand out', async () => {
    const agent = makeAgent('');
    const ctx = makeCtx({ agent, isHolding: true, claim: null });
    expect(await runOneCycle(ctx)).toBe('empty-queue');
    expect(agent.run).not.toHaveBeenCalled();
  });

  it('maps a claim RPC throw to error (outer loop backs off)', async () => {
    const agent = makeAgent('');
    const ctx = makeCtx({ agent, isHolding: true, claimThrows: true });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('skips the save when the agent returned an empty summary', async () => {
    const agent = makeAgent('');
    const saveFn = vi.fn(async () => true);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: { threadId: 't-1', terminalMsgId: 'm-1' },
      save: saveFn,
    });
    expect(await runOneCycle(ctx)).toBe('empty-summary');
    expect(saveFn).not.toHaveBeenCalled();
  });

  it('maps a successful claim→run→save to summarised', async () => {
    const agent = makeAgent('A short summary.');
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: { threadId: 't-1', terminalMsgId: 'm-1' },
      save: async () => true,
    });
    expect(await runOneCycle(ctx)).toBe('summarised');
  });

  it('maps save=false to claim-lost (race, not an error)', async () => {
    const agent = makeAgent('A short summary.');
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: { threadId: 't-1', terminalMsgId: 'm-1' },
      save: async () => false,
    });
    expect(await runOneCycle(ctx)).toBe('claim-lost');
  });

  it('maps a save RPC throw to error (not claim-lost — the state is unknown)', async () => {
    const agent = makeAgent('A short summary.');
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: { threadId: 't-1', terminalMsgId: 'm-1' },
      saveThrows: true,
    });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('propagates an agent-run error as cycle error', async () => {
    const agent = makeAgent('', 'error');
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: { threadId: 't-1', terminalMsgId: 'm-1' },
    });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('treats an aborted agent run as empty-queue (shutting down cleanly)', async () => {
    const agent = makeAgent('', 'aborted');
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: { threadId: 't-1', terminalMsgId: 'm-1' },
    });
    expect(await runOneCycle(ctx)).toBe('empty-queue');
  });
});
