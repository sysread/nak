/**
 * Coverage for the topics worker's single-cycle state machine. Shape
 * mirrors `summary-loop.test.ts` - the interesting transitions are
 * lease acquire/polling, empty queue, successful save, claim-lost on
 * stale save, empty-topics release, and error back-off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOneCycle, type CycleContext } from '../src/lib/agents/topics/loop';
import type { Agent } from '../src/lib/agents/types';
import type {
  TopicsInput,
  TopicsOutput,
} from '../src/lib/agents/topics/agent';
import type { SupabaseService } from '../src/lib/supabase';
import type { LeaseCoordinator } from '../src/lib/embeddings/lease';

type ClaimShape = {
  threadId: string;
  terminalMsgId: string;
  existingTopics: string[];
} | null;

function makeAgent(
  topics: string[],
  reason: 'done' | 'aborted' | 'error' = 'done'
): Agent<TopicsInput, TopicsOutput> {
  return {
    name: 'topics',
    model: 'fast-model',
    toolbox: { name: 'topics', description: 'stub', tools: [] },
    run: vi.fn(async () => ({
      output: { topics, inputMessageCount: 3 },
      toolCalls: 0,
      stoppedReason: reason,
    })),
  };
}

function makeCtx(opts: {
  agent: Agent<TopicsInput, TopicsOutput>;
  isHolding: boolean;
  acquire?: () => Promise<boolean>;
  claim?: ClaimShape;
  claimThrows?: boolean;
  save?: (t: string, h: string, tags: string[], m: string) => Promise<boolean>;
  saveThrows?: boolean;
  clearThrows?: boolean;
  clearFn?: ReturnType<typeof vi.fn>;
  signal?: AbortSignal;
}): CycleContext {
  const coordinator = {
    isHolding: opts.isHolding,
    acquire: opts.acquire ?? (async () => true),
    startHeartbeat: vi.fn(),
    release: vi.fn(async () => {}),
  } as unknown as LeaseCoordinator;

  const clearFn =
    opts.clearFn ??
    vi.fn(async () => {
      if (opts.clearThrows) throw new Error('boom');
    });

  const supabase = {
    claimNextThreadForTopics: vi.fn(async () => {
      if (opts.claimThrows) throw new Error('boom');
      return opts.claim ?? null;
    }),
    saveThreadTopicsIfClaimed: vi.fn(async (t: string, h: string, tags: string[], m: string) => {
      if (opts.saveThrows) throw new Error('boom');
      return (opts.save ?? (async () => true))(t, h, tags, m);
    }),
    clearTopicsClaim: clearFn,
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
    const agent = makeAgent([]);
    const ctl = new AbortController();
    ctl.abort();
    const ctx = makeCtx({ agent, isHolding: true, signal: ctl.signal });
    expect(await runOneCycle(ctx)).toBe('empty-queue');
  });

  it("polls when the lease can't be acquired", async () => {
    const agent = makeAgent([]);
    const ctx = makeCtx({ agent, isHolding: false, acquire: async () => false });
    expect(await runOneCycle(ctx)).toBe('polling');
  });

  it('reports acquired-lease on the cycle we first take the lock', async () => {
    const agent = makeAgent([]);
    const ctx = makeCtx({ agent, isHolding: false, acquire: async () => true });
    expect(await runOneCycle(ctx)).toBe('acquired-lease');
    expect(ctx.coordinator.startHeartbeat).toHaveBeenCalled();
  });

  it('returns empty-queue when the claim RPC has nothing to hand out', async () => {
    const agent = makeAgent([]);
    const ctx = makeCtx({ agent, isHolding: true, claim: null });
    expect(await runOneCycle(ctx)).toBe('empty-queue');
    expect(agent.run).not.toHaveBeenCalled();
  });

  it('maps a claim RPC throw to error (outer loop backs off)', async () => {
    const agent = makeAgent([]);
    const ctx = makeCtx({ agent, isHolding: true, claimThrows: true });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('releases the claim when the agent returned no topics', async () => {
    const agent = makeAgent([]);
    const clearFn = vi.fn(async () => {});
    const saveFn = vi.fn(async () => true);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        threadId: 't-1',
        terminalMsgId: 'm-1',
        existingTopics: [],
      },
      save: saveFn,
      clearFn,
    });
    expect(await runOneCycle(ctx)).toBe('empty-topics');
    expect(saveFn).not.toHaveBeenCalled();
    expect(clearFn).toHaveBeenCalledWith('t-1', 'h-1');
  });

  it('swallows a clear-claim throw and still returns empty-topics', async () => {
    const agent = makeAgent([]);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        threadId: 't-1',
        terminalMsgId: 'm-1',
        existingTopics: [],
      },
      clearThrows: true,
    });
    expect(await runOneCycle(ctx)).toBe('empty-topics');
  });

  it('maps a successful claim->run->save to tagged', async () => {
    const agent = makeAgent(['baking', 'sourdough']);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        threadId: 't-1',
        terminalMsgId: 'm-1',
        existingTopics: ['baking'],
      },
      save: async () => true,
    });
    expect(await runOneCycle(ctx)).toBe('tagged');
  });

  it('forwards the existing-topics vocabulary to the agent', async () => {
    const agent = makeAgent(['x']);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        threadId: 't-1',
        terminalMsgId: 'm-1',
        existingTopics: ['baking', 'bread'],
      },
      save: async () => true,
    });
    await runOneCycle(ctx);
    const call = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.input.existingTopics).toEqual(['baking', 'bread']);
  });

  it('maps save=false to claim-lost (race, not an error)', async () => {
    const agent = makeAgent(['x']);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        threadId: 't-1',
        terminalMsgId: 'm-1',
        existingTopics: [],
      },
      save: async () => false,
    });
    expect(await runOneCycle(ctx)).toBe('claim-lost');
  });

  it('maps a save RPC throw to error', async () => {
    const agent = makeAgent(['x']);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        threadId: 't-1',
        terminalMsgId: 'm-1',
        existingTopics: [],
      },
      saveThrows: true,
    });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('propagates an agent-run error as cycle error', async () => {
    const agent = makeAgent([], 'error');
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        threadId: 't-1',
        terminalMsgId: 'm-1',
        existingTopics: [],
      },
    });
    expect(await runOneCycle(ctx)).toBe('error');
  });
});
