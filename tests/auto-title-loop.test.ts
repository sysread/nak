/**
 * Coverage for the auto-title worker's single-cycle state machine.
 * Mirrors `summary-loop.test.ts` - the interesting transitions are
 * lease acquire/polling, empty queue, successful save, claim-lost on
 * stale save, no-title (title-gen returned null), and error back-off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOneCycle, type CycleContext } from '../src/lib/agents/auto_title/loop';
import type { SupabaseService } from '../src/lib/supabase';
import type { LeaseCoordinator } from '../src/lib/embeddings/lease';
import type {
  ChatRequest,
  ChatCompletion,
} from '../src/lib/venice';

type ClaimShape = { threadId: string; userText: string } | null;

function mkCompletion(text: string): ChatCompletion {
  return {
    text,
    reasoning: '',
    toolCalls: [],
    usage: null,
    citations: [],
    finishReason: 'stop',
  };
}

/**
 * Default `SupabaseService.complete` stub used by makeCtx. title-gen
 * (which the cycle calls into) now talks to the venice edge function
 * via SupabaseService.complete instead of VeniceClient.completeChat,
 * so the mock lives on the supabase side. Tests that need a different
 * completion shape override the function through makeCtx's `complete`
 * opt.
 */
function defaultComplete(): (req: ChatRequest) => Promise<ChatCompletion> {
  return async () => mkCompletion('A useful title');
}

function makeCtx(opts: {
  isHolding: boolean;
  acquire?: () => Promise<boolean>;
  claim?: ClaimShape;
  claimThrows?: boolean;
  save?: (t: string, h: string, title: string) => Promise<boolean>;
  saveThrows?: boolean;
  clearClaim?: (t: string, h: string) => Promise<void>;
  complete?: (req: ChatRequest) => Promise<ChatCompletion>;
  signal?: AbortSignal;
}): CycleContext {
  const coordinator = {
    isHolding: opts.isHolding,
    acquire: opts.acquire ?? (async () => true),
    startHeartbeat: vi.fn(),
    release: vi.fn(async () => {}),
  } as unknown as LeaseCoordinator;

  const supabase = {
    claimNextThreadForAutoTitle: vi.fn(async () => {
      if (opts.claimThrows) throw new Error('boom');
      return opts.claim ?? null;
    }),
    saveThreadTitleIfClaimed: vi.fn(
      async (t: string, h: string, title: string) => {
        if (opts.saveThrows) throw new Error('boom');
        return (opts.save ?? (async () => true))(t, h, title);
      },
    ),
    clearAutoTitleClaim: vi.fn(opts.clearClaim ?? (async () => {})),
    complete: vi.fn(opts.complete ?? defaultComplete()),
  } as unknown as SupabaseService;

  return {
    supabase,
    coordinator,
    holderId: 'h-1',
    threadClaimTtlSeconds: 60,
    signal: opts.signal ?? new AbortController().signal,
    onLeaseLost: vi.fn(),
  };
}

describe('runOneCycle', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns empty-queue when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const ctx = makeCtx({ isHolding: true, signal: ctl.signal });
    expect(await runOneCycle(ctx)).toBe('empty-queue');
  });

  it("polls when the lease can't be acquired", async () => {
    const ctx = makeCtx({ isHolding: false, acquire: async () => false });
    expect(await runOneCycle(ctx)).toBe('polling');
  });

  it('reports acquired-lease on the cycle we first take the lock', async () => {
    const ctx = makeCtx({ isHolding: false, acquire: async () => true });
    expect(await runOneCycle(ctx)).toBe('acquired-lease');
    expect(ctx.coordinator.startHeartbeat).toHaveBeenCalled();
  });

  it('returns empty-queue when the claim RPC has nothing to hand out', async () => {
    const completeFn = vi.fn(async () => mkCompletion('A useful title'));
    const ctx = makeCtx({ isHolding: true, claim: null, complete: completeFn });
    expect(await runOneCycle(ctx)).toBe('empty-queue');
    // No claim => no completion call. Don't burn a request on an empty queue.
    expect(completeFn).not.toHaveBeenCalled();
  });

  it('maps a claim RPC throw to error (outer loop backs off)', async () => {
    const ctx = makeCtx({ isHolding: true, claimThrows: true });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('maps a successful claim->title-gen->save to titled', async () => {
    const ctx = makeCtx({
      isHolding: true,
      claim: { threadId: 't-1', userText: 'help with python decorators' },
      save: async () => true,
    });
    expect(await runOneCycle(ctx)).toBe('titled');
  });

  it('passes the claimed user text through to title-gen verbatim', async () => {
    // The claim RPC returns the first user message; title-gen should
    // receive that text and nothing else (no chat history, no recall
    // context, no priming). The worker is a clean re-implementation of
    // the in-Chat trigger's call site - same input, same model.
    const seen: ChatRequest[] = [];
    const ctx = makeCtx({
      isHolding: true,
      claim: { threadId: 't-1', userText: 'help me understand python decorators' },
      save: async () => true,
      complete: async (req) => {
        seen.push(req);
        return mkCompletion('Decorators primer');
      },
    });
    expect(await runOneCycle(ctx)).toBe('titled');
    expect(seen).toHaveLength(1);
    expect(seen[0].messages).toHaveLength(2);
    expect(seen[0].messages[1]).toEqual({
      role: 'user',
      content: 'help me understand python decorators',
    });
  });

  it('clears the claim and reports no-title when title-gen returns null', async () => {
    // Empty completion => sanitised title is empty => generateThreadTitle
    // returns null. The loop releases the per-thread claim so the row
    // re-enters the queue immediately rather than waiting for the 60s
    // claim TTL to expire.
    const clearSpy = vi.fn(async () => {});
    const saveFn = vi.fn(async () => true);
    const ctx = makeCtx({
      isHolding: true,
      claim: { threadId: 't-1', userText: 'hello' },
      save: saveFn,
      clearClaim: clearSpy,
      complete: async () => mkCompletion('   '),
    });
    expect(await runOneCycle(ctx)).toBe('no-title');
    expect(clearSpy).toHaveBeenCalledWith('t-1', 'h-1');
    expect(saveFn).not.toHaveBeenCalled();
  });

  it('still reports no-title when the clear-claim RPC throws (best-effort)', async () => {
    // The clear is a "release the claim early" optimisation; if it
    // fails the per-thread TTL takes over. The cycle must not turn
    // a failed clear into an error - that would muddle the transition
    // semantics for the outer loop.
    const ctx = makeCtx({
      isHolding: true,
      claim: { threadId: 't-1', userText: 'hi' },
      clearClaim: async () => {
        throw new Error('clear boom');
      },
      complete: async () => mkCompletion(''),
    });
    expect(await runOneCycle(ctx)).toBe('no-title');
  });

  it('maps save=false to claim-lost (race with manual rename or update_title, not an error)', async () => {
    const ctx = makeCtx({
      isHolding: true,
      claim: { threadId: 't-1', userText: 'something interesting' },
      save: async () => false,
    });
    expect(await runOneCycle(ctx)).toBe('claim-lost');
  });

  it('maps a save RPC throw to error (state is unknown - back off and retry)', async () => {
    const ctx = makeCtx({
      isHolding: true,
      claim: { threadId: 't-1', userText: 'something interesting' },
      saveThrows: true,
    });
    expect(await runOneCycle(ctx)).toBe('error');
  });

  it('propagates a Venice throw via title-gen as no-title (caller releases claim)', async () => {
    // generateThreadTitle catches Venice errors and returns null. From
    // the loop's perspective that's the same as an empty completion -
    // no title to save, release the claim and let the next cycle retry.
    // This is the auto-title pipeline's load-bearing best-effort posture.
    const clearSpy = vi.fn(async () => {});
    const ctx = makeCtx({
      isHolding: true,
      claim: { threadId: 't-1', userText: 'hello' },
      clearClaim: clearSpy,
      complete: async () => {
        throw new Error('venice exploded');
      },
    });
    expect(await runOneCycle(ctx)).toBe('no-title');
    expect(clearSpy).toHaveBeenCalledWith('t-1', 'h-1');
  });
});
