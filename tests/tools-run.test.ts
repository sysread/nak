/**
 * Unit coverage for `runHeadlessToolLoop` — the shared tool-call loop
 * used by background agents. The interesting state transitions are:
 *
 *   - terminal response (no tool calls) → returns finalText and exits
 *   - assistant emits tool_calls → we execute them and continue
 *   - execution concurrency — every call gets a child AbortController
 *   - pre-aborted signal short-circuits without invoking Venice
 *   - maxRounds cap trips `stoppedByLimit`
 *
 * Venice is mocked as an async generator so each test can script the
 * exact event sequence the loop should see. The toolbox is mocked with
 * a single `spy` tool whose handler is a vi.fn — tests drive its
 * resolve/reject values and assert what arguments it saw.
 */
import { describe, it, expect, vi } from 'vitest';
import { runHeadlessToolLoop, MAX_AGENT_DEPTH } from '../src/lib/tools/run';
import type { Toolbox, ToolContext, ToolDef } from '../src/lib/tools/types';
import type {
  ChatCompletion,
  OpenAIToolCall,
  VeniceClient,
  VeniceMessage,
} from '../src/lib/venice';
import type { SupabaseService } from '../src/lib/supabase';

/**
 * Per-round shape the test scripts. The headless loop now drives
 * `venice.completeChat`, which returns a single record per round
 * rather than a stream of events. Tests script `{text, toolCalls?}`
 * for each round; the helper fills the rest of the ChatCompletion
 * shape with empty defaults.
 */
interface RoundScript {
  text?: string;
  toolCalls?: OpenAIToolCall[];
}

/** Script a venice.completeChat with one canned ChatCompletion per round. */
function makeVenice(
  rounds: RoundScript[]
): { venice: VeniceClient; streamCalls: VeniceMessage[][] } {
  // Each round's response comes from rounds[i]; we shift off the front
  // so call 1 sees rounds[0], call 2 sees rounds[1], etc. Naming the
  // observation array `streamCalls` for diff churn reasons - it still
  // captures the per-round message list.
  const remaining = rounds.slice();
  const streamCalls: VeniceMessage[][] = [];
  const completeChat = vi.fn(
    async (req: { messages: VeniceMessage[] }): Promise<ChatCompletion> => {
      // Snapshot the messages we were called with so assertions can
      // inspect round-N's payload without racing the loop's own
      // in-place extensions.
      streamCalls.push(req.messages.map((m) => ({ ...m })));
      const script = remaining.shift() ?? {};
      return {
        text: script.text ?? '',
        reasoning: '',
        toolCalls: script.toolCalls ?? [],
        usage: null,
        citations: [],
        finishReason: (script.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop',
      };
    }
  );
  return {
    venice: { completeChat } as unknown as VeniceClient,
    streamCalls,
  };
}

function makeToolbox(handler: ToolDef['execute'] = async () => ({ ok: true })): {
  toolbox: Toolbox;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(handler);
  const tool: ToolDef = {
    name: 'spy',
    description: 'test spy',
    shortDescription: 'test',
    parameters: {},
    execute: spy,
  };
  const toolbox: Toolbox = { name: 'test', description: 'test', tools: [tool] };
  return { toolbox, spy };
}

function baseCtx(): Omit<ToolContext, 'signal'> {
  return {
    supabase: {} as unknown as SupabaseService,
    venice: {} as unknown as VeniceClient,
    userId: 'u',
    threadId: 't',
  };
}

describe('runHeadlessToolLoop — terminal paths', () => {
  it('returns finalText and exits when round 1 has no tool calls', async () => {
    const { venice } = makeVenice([{ text: 'hello world' }]);
    const { toolbox, spy } = makeToolbox();

    const result = await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('hello world');
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.stoppedByLimit).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('executes a tool call, feeds the result back, and exits on the next terminal round', async () => {
    const { venice, streamCalls } = makeVenice([
      // Round 1: model asks for one tool call.
      {
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'spy', arguments: '{"x":1}' },
          },
        ],
      },
      // Round 2: model replies with text only - loop exits.
      { text: 'done' },
    ]);
    const { toolbox, spy } = makeToolbox(async () => ({ echoed: true }));

    const result = await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'please call spy' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('done');
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    // Round 2's message list must carry the assistant-with-tool-calls
    // row AND the tool-result row — OpenAI rejects a list where a
    // tool_call lacks a matching subsequent role='tool'.
    const r2 = streamCalls[1];
    const assistantRow = r2.find((m) => m.role === 'assistant');
    expect(assistantRow?.tool_calls?.[0].id).toBe('call-1');
    const toolRow = r2.find((m) => m.role === 'tool');
    expect(toolRow?.tool_call_id).toBe('call-1');
    expect(toolRow?.name).toBe('spy');
    // Result content is JSON-encoded so the model sees structured data.
    expect(toolRow?.content).toBe(JSON.stringify({ echoed: true }));
  });

  it('issues multiple tool calls concurrently on one round', async () => {
    // Tracks call-started timestamps so we can assert they fired
    // before any of them resolved — if the loop ran them serially,
    // the second start would land after the first finish.
    const startTimes: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const { venice } = makeVenice([
      {
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'spy', arguments: '{"n":1}' },
          },
          {
            id: 'c2',
            type: 'function',
            function: { name: 'spy', arguments: '{"n":2}' },
          },
        ],
      },
      { text: 'done' },
    ]);
    const { toolbox } = makeToolbox(async () => {
      startTimes.push(Date.now());
      await gate;
      return { ok: true };
    });

    const promise = runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: new AbortController().signal,
    });
    // Let both tool handlers start (microtask + next tick).
    await new Promise((r) => setTimeout(r, 5));
    expect(startTimes.length).toBe(2);
    release();
    const result = await promise;
    expect(result.toolCalls).toBe(2);
  });
});

describe('runHeadlessToolLoop — error paths', () => {
  it('surfaces a tool error as a JSON-encoded tool-result and continues', async () => {
    const { venice, streamCalls } = makeVenice([
      {
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'spy', arguments: '{}' },
          },
        ],
      },
      { text: 'ok' },
    ]);
    const { toolbox } = makeToolbox(async () => {
      throw new Error('tool blew up');
    });

    const result = await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('ok');
    expect(result.toolCalls).toBe(1);
    const toolRow = streamCalls[1].find((m) => m.role === 'tool');
    // content was widened to `string | ContentPart[]` when vision
    // inlining landed; tool rows are always strings, assert and
    // narrow before parsing.
    expect(typeof toolRow?.content).toBe('string');
    const toolContent = toolRow?.content as string;
    expect(toolContent).toContain('tool blew up');
    expect(() => JSON.parse(toolContent)).not.toThrow();
  });

  it('surfaces an invalid-JSON arguments blob as a tool error without calling the handler', async () => {
    // Model emitted a broken arguments string — a real failure mode.
    // The tool must not run with unparsed args; the model sees the
    // JSON parse error on its next turn and can retry.
    const { venice } = makeVenice([
      {
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'spy', arguments: '{broken' },
          },
        ],
      },
      { text: 'recovered' },
    ]);
    const { toolbox, spy } = makeToolbox();

    const result = await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('recovered');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('runHeadlessToolLoop — abort and limits', () => {
  it('short-circuits with rounds=0 when the signal is already aborted', async () => {
    // No rounds scripted - if the loop calls completeChat at all, the
    // default empty response would still drive a tool-less terminal
    // round. The pre-aborted check prevents the call entirely.
    const { venice } = makeVenice([]);
    const { toolbox } = makeToolbox();
    const ac = new AbortController();
    ac.abort();

    const result = await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: ac.signal,
    });

    expect(result.rounds).toBe(0);
    expect(result.finalText).toBe('');
    expect(venice.completeChat).not.toHaveBeenCalled();
  });

  it('honors maxRounds as a circuit breaker and reports stoppedByLimit', async () => {
    // Every round asks for a tool call; no round ever produces terminal
    // text. Without maxRounds this would loop forever.
    const makeRound = (id: string): RoundScript => ({
      toolCalls: [
        {
          id,
          type: 'function',
          function: { name: 'spy', arguments: '{}' },
        },
      ],
    });
    const { venice } = makeVenice([makeRound('a'), makeRound('b'), makeRound('c')]);
    const { toolbox } = makeToolbox();

    const result = await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: new AbortController().signal,
      maxRounds: 2,
    });

    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.stoppedByLimit).toBe(true);
    expect(result.finalText).toBe('');
  });

  it('threads the caller signal into the tool context as a child signal', async () => {
    // The child must abort when the parent aborts, but must NOT be the
    // exact same signal (wrapping lets the loop scope per-call teardown
    // without cancelling the outer context). We assert the seen signal
    // reports aborted once the parent is aborted.
    let seenSignal: AbortSignal | undefined;
    const { venice } = makeVenice([
      {
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'spy', arguments: '{}' },
          },
        ],
      },
      { text: 'ok' },
    ]);
    const { toolbox } = makeToolbox(async (_args, ctx: ToolContext) => {
      seenSignal = ctx.signal;
      return null;
    });

    const ac = new AbortController();
    await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: ac.signal,
    });

    expect(seenSignal).toBeDefined();
    expect(seenSignal).not.toBe(ac.signal);
    expect(seenSignal!.aborted).toBe(false);
    ac.abort();
    // The child was linked with `once: true`, so parent aborting
    // propagates at abort-time.
    expect(seenSignal!.aborted).toBe(true);
  });
});

describe('runHeadlessToolLoop — agent recursion depth', () => {
  it('stamps depth=1 on the per-call ctx when the caller is the main chat (depth 0)', async () => {
    // Main-chat semantics: caller's toolCtx has depth 0 (or undefined).
    // The agent we are starting runs at depth 1, and the tool should
    // see ctx.depth === 1 so a future spawn checks against the right
    // base.
    let seenDepth: number | undefined = -1;
    const { venice } = makeVenice([
      {
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'spy', arguments: '{}' } },
        ],
      },
      { text: 'ok' },
    ]);
    const { toolbox } = makeToolbox(async (_args, ctx: ToolContext) => {
      seenDepth = ctx.depth;
      return null;
    });

    await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(),
      signal: new AbortController().signal,
    });

    expect(seenDepth).toBe(1);
  });

  it('bumps depth on each level of nesting', async () => {
    // Caller at depth 1 (e.g. an agent's tool that spawned this one)
    // should see its tools running at depth 2.
    let seenDepth: number | undefined = -1;
    const { venice } = makeVenice([
      {
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'spy', arguments: '{}' } },
        ],
      },
      { text: 'ok' },
    ]);
    const { toolbox } = makeToolbox(async (_args, ctx: ToolContext) => {
      seenDepth = ctx.depth;
      return null;
    });

    await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: { ...baseCtx(), depth: 1 },
      signal: new AbortController().signal,
    });

    expect(seenDepth).toBe(2);
  });

  it('throws before any Venice call when depth would exceed MAX_AGENT_DEPTH', async () => {
    // Caller already at the cap; the agent we are about to start
    // would run at MAX_AGENT_DEPTH + 1, which is over.
    const { venice } = makeVenice([]);
    const { toolbox } = makeToolbox();

    await expect(
      runHeadlessToolLoop({
        venice,
        model: 'm',
        messages: [{ role: 'user', content: 'go' }],
        toolbox,
        toolCtx: { ...baseCtx(), depth: MAX_AGENT_DEPTH },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/depth limit/);

    expect(venice.completeChat).not.toHaveBeenCalled();
  });

  it('allows depth exactly at MAX_AGENT_DEPTH (caller at MAX-1)', async () => {
    // Boundary case: caller depth MAX-1 means the agent runs at MAX.
    // That's the deepest legitimate level - it must not throw.
    const { venice } = makeVenice([{ text: 'ok' }]);
    const { toolbox } = makeToolbox();

    const result = await runHeadlessToolLoop({
      venice,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      toolbox,
      toolCtx: { ...baseCtx(), depth: MAX_AGENT_DEPTH - 1 },
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('ok');
  });
});
