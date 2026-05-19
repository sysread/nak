/**
 * Coverage for the memory-topics worker's single-cycle state machine.
 * Shape mirrors `topics-loop.test.ts` deliberately - the transitions
 * are identical, only the claim shape differs (memory id + label +
 * data vs thread id + terminal msg id) and the save signature drops
 * the msg_id arg.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runOneCycle,
  type CycleContext,
} from '../src/lib/agents/memory_topics/loop';
import type { Agent } from '../src/lib/agents/types';
import type {
  MemoryTopicsInput,
  MemoryTopicsOutput,
} from '../src/lib/agents/memory_topics/agent';
import type { SupabaseService } from '../src/lib/supabase';
import type { LeaseCoordinator } from '../src/lib/embeddings/lease';

type ClaimShape = {
  memoryId: string;
  label: string;
  data: string;
  existingTopics: string[];
} | null;

function makeAgent(
  topics: string[],
  reason: 'done' | 'aborted' | 'error' = 'done'
): Agent<MemoryTopicsInput, MemoryTopicsOutput> {
  return {
    name: 'memory-topics',
    model: 'fast-model',
    toolbox: { name: 'memory-topics', description: 'stub', tools: [] },
    run: vi.fn(async () => ({
      output: { topics },
      toolCalls: 0,
      stoppedReason: reason,
    })),
  };
}

function makeCtx(opts: {
  agent: Agent<MemoryTopicsInput, MemoryTopicsOutput>;
  isHolding: boolean;
  acquire?: () => Promise<boolean>;
  claim?: ClaimShape;
  claimThrows?: boolean;
  save?: (m: string, h: string, tags: string[]) => Promise<boolean>;
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
    claimNextMemoryForTopics: vi.fn(async () => {
      if (opts.claimThrows) throw new Error('boom');
      return opts.claim ?? null;
    }),
    saveMemoryTopicsIfClaimed: vi.fn(
      async (m: string, h: string, tags: string[]) => {
        if (opts.saveThrows) throw new Error('boom');
        return (opts.save ?? (async () => true))(m, h, tags);
      }
    ),
    clearMemoryTopicsClaim: clearFn,
  } as unknown as SupabaseService;

  return {
    agent: opts.agent,
    supabase,
    coordinator,
    holderId: 'h-1',
    userId: 'u-1',
    memoryClaimTtlSeconds: 60,
    signal: opts.signal ?? new AbortController().signal,
    onLeaseLost: vi.fn(),
  };
}

const sampleClaim: NonNullable<ClaimShape> = {
  memoryId: 'mem-1',
  label: 'Likes spicy food',
  data: 'Prefers Indian and Thai cuisine.',
  existingTopics: [],
};

describe('memory-topics runOneCycle', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('returns empty-queue when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const ctx = makeCtx({
      agent: makeAgent([]),
      isHolding: true,
      signal: ctl.signal,
    });
    expect(await runOneCycle(ctx)).toBe('empty-queue');
  });

  it("polls when the lease can't be acquired", async () => {
    const ctx = makeCtx({
      agent: makeAgent([]),
      isHolding: false,
      acquire: async () => false,
    });
    expect(await runOneCycle(ctx)).toBe('polling');
  });

  it('reports acquired-lease on the cycle we first take the lock', async () => {
    const ctx = makeCtx({
      agent: makeAgent([]),
      isHolding: false,
      acquire: async () => true,
    });
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
    const ctx = makeCtx({
      agent: makeAgent([]),
      isHolding: true,
      claimThrows: true,
    });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('releases the claim when the agent returned no topics', async () => {
    const clearFn = vi.fn(async () => {});
    const saveFn = vi.fn(async () => true);
    const ctx = makeCtx({
      agent: makeAgent([]),
      isHolding: true,
      claim: sampleClaim,
      save: saveFn,
      clearFn,
    });
    expect(await runOneCycle(ctx)).toBe('empty-topics');
    expect(saveFn).not.toHaveBeenCalled();
    expect(clearFn).toHaveBeenCalledWith('mem-1', 'h-1');
  });

  it('swallows a clear-claim throw and still returns empty-topics', async () => {
    const ctx = makeCtx({
      agent: makeAgent([]),
      isHolding: true,
      claim: sampleClaim,
      clearThrows: true,
    });
    expect(await runOneCycle(ctx)).toBe('empty-topics');
  });

  it('maps a successful claim->run->save to tagged', async () => {
    const ctx = makeCtx({
      agent: makeAgent(['food', 'preferences']),
      isHolding: true,
      claim: sampleClaim,
      save: async () => true,
    });
    expect(await runOneCycle(ctx)).toBe('tagged');
  });

  it('forwards the memory label+data and existing-topics vocab to the agent', async () => {
    const agent = makeAgent(['x']);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        ...sampleClaim,
        existingTopics: ['food', 'travel'],
      },
      save: async () => true,
    });
    await runOneCycle(ctx);
    const call = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.input.label).toBe(sampleClaim.label);
    expect(call.input.data).toBe(sampleClaim.data);
    expect(call.input.existingTopics).toEqual(['food', 'travel']);
  });

  it('maps save=false to claim-lost (race or mid-flight content edit)', async () => {
    const ctx = makeCtx({
      agent: makeAgent(['x']),
      isHolding: true,
      claim: sampleClaim,
      save: async () => false,
    });
    expect(await runOneCycle(ctx)).toBe('claim-lost');
  });

  it('maps a save RPC throw to error', async () => {
    const ctx = makeCtx({
      agent: makeAgent(['x']),
      isHolding: true,
      claim: sampleClaim,
      saveThrows: true,
    });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('propagates an agent-run error as cycle error', async () => {
    const ctx = makeCtx({
      agent: makeAgent([], 'error'),
      isHolding: true,
      claim: sampleClaim,
    });
    expect(await runOneCycle(ctx)).toBe('error');
  });
});
