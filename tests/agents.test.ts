/**
 * Contract tests for the `Agent` interface.
 *
 * The interface backs the supervised browser agents (summary, topics,
 * memory_topics, recipe_topics). This file is the sentinel on the
 * shared contract itself, driven by a trivial in-memory witness rather
 * than any one production agent. What we verify here is that the
 * interface stays usable:
 *
 *   1. A trivial in-memory implementation assigns cleanly to
 *      `Agent<Req, Res>` with narrowed generics — if the interface
 *      drifts (extra required members, mis-shaped return type) these
 *      tests stop compiling.
 *   2. `run()` threads its AbortSignal through to a tool context so
 *      callers can cancel fire-and-forget runs.
 *   3. The `AgentRunResult` discriminants (`stoppedReason`, `toolCalls`,
 *      `error`) carry the intended information on each exit path —
 *      done, aborted, error — so observability downstream doesn't have
 *      to re-derive state from `output` alone.
 *
 * When the first real agent lands, its integration tests will exercise
 * the tool-call loop and prompt logic; these stay as a sentinel on
 * the shared contract.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Agent, AgentRunRequest, AgentRunResult } from '../src/lib/agents/types';
import { executeToolboxCall, type ToolContext, type Toolbox } from '../src/lib/tools';
import type { SupabaseService } from '../src/lib/supabase';

/**
 * Minimal inline toolbox so the contract witness doesn't couple to any
 * production toolbox's composition (those churn as agents migrate
 * server-side). The single memory_create tool routes to
 * SupabaseService.createMemory exactly as the real tool does, including
 * passing the absent `confidence` through as undefined, so the spy
 * assertion below stays meaningful.
 */
const ECHO_TOOLBOX: Toolbox = {
  name: 'echo-toolbox',
  description: 'single create tool for the contract witness',
  tools: [
    {
      name: 'memory_create',
      description: 'create a memory',
      shortDescription: 'create',
      parameters: {},
      execute: (args: Record<string, unknown>, ctx: ToolContext) =>
        (ctx.supabase as unknown as {
          createMemory: (l: string, d: string, c?: number) => Promise<unknown>;
        }).createMemory(
          args.label as string,
          args.data as string,
          args.confidence as number | undefined,
        ),
    },
  ],
};

/**
 * A minimal concrete agent used only by these tests. It's deliberately
 * NOT a realistic agent (no model call, no prompt) — its job is to
 * prove the interface holds shape under real use: construct, run, get
 * a typed result back. Making it drive a single tool call also lets us
 * assert that the `AbortSignal` on the request ends up on the tool
 * context, which is the invariant agents need so a `stop()` on the
 * outer run cancels in-flight Supabase/Venice calls.
 */
interface EchoRequest {
  label: string;
  data: string;
}
interface EchoResponse {
  createdId: string;
}

class EchoAgent implements Agent<EchoRequest, EchoResponse> {
  readonly name = 'echo';
  readonly model = 'venice-test-model';
  readonly toolbox = ECHO_TOOLBOX;

  constructor(private supabase: SupabaseService) {}

  async run(
    req: AgentRunRequest<EchoRequest>
  ): Promise<AgentRunResult<EchoResponse>> {
    // Bail immediately if the caller already aborted — an agent that
    // ignores a pre-aborted signal will happily do one turn of work
    // before noticing, which is exactly the footgun the signal is
    // there to prevent.
    if (req.signal?.aborted) {
      return {
        output: { createdId: '' },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }
    const ctx: ToolContext = {
      supabase: this.supabase,
      userId: req.userId,
      threadId: req.threadId ?? 't-agent',
      signal: req.signal ?? new AbortController().signal,
    };
    try {
      const created = (await executeToolboxCall(
        this.toolbox,
        'memory_create',
        { label: req.input.label, data: req.input.data, message: 'echo create' },
        ctx
      )) as { id: string };
      return {
        output: { createdId: created.id },
        toolCalls: 1,
        stoppedReason: 'done',
      };
    } catch (err) {
      return {
        output: { createdId: '' },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Stubs mirror the shape in tools.test.ts. We only need createMemory
 * because EchoAgent only calls memory_create — unused methods stay
 * spyless so failures point at actual mis-routes.
 */
function mockSupabase(): {
  svc: SupabaseService;
  spies: {
    createMemory: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    createMemory: vi.fn(async (label: string, data: string) => ({
      id: 'mem-123',
      label,
      data,
      created_at: 't',
      updated_at: 't',
    })),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

describe('Agent interface — EchoAgent as contract witness', () => {
  it('exposes the three readonly identity fields', () => {
    const agent = new EchoAgent(mockSupabase().svc);
    expect(agent.name).toBe('echo');
    expect(agent.model).toBe('venice-test-model');
    expect(agent.toolbox).toBe(ECHO_TOOLBOX);
  });

  it('run() returns a typed result on the happy path with toolCalls counted', async () => {
    const { svc, spies } = mockSupabase();
    const agent = new EchoAgent(svc);
    const result = await agent.run({
      input: { label: 'note', data: 'body' },
      userId: 'u-1',
      threadId: 't-1',
    });
    expect(result.stoppedReason).toBe('done');
    expect(result.output.createdId).toBe('mem-123');
    expect(result.toolCalls).toBe(1);
    expect(result.error).toBeUndefined();
    // createMemory's signature grew an optional `confidence` param
    // for the volitional-memory layer; the Echo agent uses the vanilla
    // memory_create tool, which passes undefined when absent.
    expect(spies.createMemory).toHaveBeenCalledWith('note', 'body', undefined);
  });

  it('threads req.signal through to the tool context — abort cascades to tools', async () => {
    // Capture the ToolContext the handler receives by using a custom
    // toolbox whose tool records the context. This proves the agent
    // isn't silently swapping signals or dropping the field; an agent
    // that doesn't propagate would fail here and fail for real callers
    // the same way.
    const { svc } = mockSupabase();
    let capturedSignal: AbortSignal | undefined;
    const recordingAgent = new (class implements Agent<void, void> {
      readonly name = 'record';
      readonly model = 'venice-test-model';
      readonly toolbox = {
        name: 'record-toolbox',
        description: 'records signal',
        tools: [
          {
            name: 'record',
            description: 'record',
            shortDescription: 'record',
            parameters: {},
            async execute(_args: Record<string, unknown>, ctx: ToolContext) {
              capturedSignal = ctx.signal;
              return null;
            },
          },
        ],
      };
      async run(req: AgentRunRequest<void>): Promise<AgentRunResult<void>> {
        await executeToolboxCall(this.toolbox, 'record', {}, {
          supabase: svc,
          userId: req.userId,
          threadId: req.threadId ?? 't-x',
          signal: req.signal ?? new AbortController().signal,
        });
        return { output: undefined, toolCalls: 1, stoppedReason: 'done' };
      }
    })();

    const ac = new AbortController();
    await recordingAgent.run({ input: undefined, userId: 'u-1', signal: ac.signal });
    expect(capturedSignal).toBe(ac.signal);
  });

  it('short-circuits to stoppedReason=aborted when the signal is already aborted', async () => {
    const agent = new EchoAgent(mockSupabase().svc);
    const ac = new AbortController();
    ac.abort();
    const result = await agent.run({
      input: { label: 'x', data: 'y' },
      userId: 'u-1',
      signal: ac.signal,
    });
    expect(result.stoppedReason).toBe('aborted');
    // No tool calls issued — the pre-aborted check must fire before
    // any side effect. Otherwise a cancelled reflection could still
    // write a memory, which defeats the purpose of the signal.
    expect(result.toolCalls).toBe(0);
  });

  it('populates stoppedReason=error + error message when a tool call throws', async () => {
    // Simulate Supabase surfacing a failure by having the handler
    // reject. The agent must catch, record the reason, and still
    // return a well-formed result — callers that await `run()` should
    // never need a try/catch on the boundary.
    const svc = {
      createMemory: vi.fn(async () => {
        throw new Error('simulated RLS denial');
      }),
    } as unknown as SupabaseService;
    const agent = new EchoAgent(svc);
    const result = await agent.run({
      input: { label: 'x', data: 'y' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('error');
    expect(result.error).toMatch(/simulated RLS denial/);
    expect(result.toolCalls).toBe(0);
  });

  it('accepts an omitted threadId (non-thread-scoped agents are valid)', async () => {
    // Not every agent is thread-scoped — e.g. a future "summarise the
    // whole memory graph" agent. The interface keeps threadId optional
    // and implementations that need it assert or narrow themselves.
    const agent = new EchoAgent(mockSupabase().svc);
    const result = await agent.run({
      input: { label: 'x', data: 'y' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('done');
  });
});
