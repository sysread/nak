/**
 * Coverage for the recipe-topics worker's single-cycle state machine.
 * Mirrors `memory-topics-loop.test.ts` - the transitions are
 * identical, only the claim shape differs (recipe id + title +
 * cooklang vs memory id + label + data).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runOneCycle,
  type CycleContext,
} from '../src/lib/agents/recipe_topics/loop';
import type { Agent } from '../src/lib/agents/types';
import type {
  RecipeTopicsInput,
  RecipeTopicsOutput,
} from '../src/lib/agents/recipe_topics/agent';
import type { SupabaseService } from '../src/lib/supabase';
import type { LeaseCoordinator } from '../src/lib/embeddings/lease';

type ClaimShape = {
  recipeId: string;
  title: string;
  cooklang: string;
  existingTopics: string[];
} | null;

function makeAgent(
  topics: string[],
  reason: 'done' | 'aborted' | 'error' = 'done'
): Agent<RecipeTopicsInput, RecipeTopicsOutput> {
  return {
    name: 'recipe-topics',
    model: 'fast-model',
    toolbox: { name: 'recipe-topics', description: 'stub', tools: [] },
    run: vi.fn(async () => ({
      output: { topics },
      toolCalls: 0,
      stoppedReason: reason,
    })),
  };
}

function makeCtx(opts: {
  agent: Agent<RecipeTopicsInput, RecipeTopicsOutput>;
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
    claimNextRecipeForTopics: vi.fn(async () => {
      if (opts.claimThrows) throw new Error('boom');
      return opts.claim ?? null;
    }),
    saveRecipeTopicsIfClaimed: vi.fn(
      async (m: string, h: string, tags: string[]) => {
        if (opts.saveThrows) throw new Error('boom');
        return (opts.save ?? (async () => true))(m, h, tags);
      }
    ),
    clearRecipeTopicsClaim: clearFn,
  } as unknown as SupabaseService;

  return {
    agent: opts.agent,
    supabase,
    coordinator,
    holderId: 'h-1',
    userId: 'u-1',
    recipeClaimTtlSeconds: 60,
    signal: opts.signal ?? new AbortController().signal,
    onLeaseLost: vi.fn(),
  };
}

const sampleClaim: NonNullable<ClaimShape> = {
  recipeId: 'rec-1',
  title: 'Chicken Tikka Masala',
  cooklang: 'Marinate @chicken{500%g} in @yogurt{100%g}.',
  existingTopics: [],
};

describe('recipe-topics runOneCycle', () => {
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
    expect(clearFn).toHaveBeenCalledWith('rec-1', 'h-1');
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
      agent: makeAgent(['chicken', 'indian', 'curry', 'dinner']),
      isHolding: true,
      claim: sampleClaim,
      save: async () => true,
    });
    expect(await runOneCycle(ctx)).toBe('tagged');
  });

  it('forwards title + cooklang + existing-topics vocab to the agent', async () => {
    const agent = makeAgent(['x']);
    const ctx = makeCtx({
      agent,
      isHolding: true,
      claim: {
        ...sampleClaim,
        existingTopics: ['italian', 'pasta'],
      },
      save: async () => true,
    });
    await runOneCycle(ctx);
    const call = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.input.title).toBe(sampleClaim.title);
    expect(call.input.cooklang).toBe(sampleClaim.cooklang);
    expect(call.input.existingTopics).toEqual(['italian', 'pasta']);
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
