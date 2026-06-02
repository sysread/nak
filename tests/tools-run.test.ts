/**
 * Unit coverage for `runHeadlessToolLoop` — the shared tool-call loop
 * used by background agents. The interesting state transitions are:
 *
 *   - terminal response (no tool calls) → returns finalText and exits
 *   - assistant emits tool_calls → we execute them and continue
 *   - execution concurrency — every call gets a child AbortController
 *   - pre-aborted signal short-circuits without invoking the function
 *   - maxRounds cap trips `stoppedByLimit`
 *
 * The non-streaming chat seam is mocked at `SupabaseService.complete`:
 * each test scripts one ChatCompletion record per round. The toolbox
 * is mocked with a single `spy` tool whose handler is a vi.fn — tests
 * drive its resolve/reject values and assert what arguments it saw.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runHeadlessToolLoop,
  MAX_AGENT_DEPTH,
  type HeadlessToolLoopEvent,
} from '../src/lib/tools/run';
import type { Toolbox, ToolContext, ToolDef } from '../src/lib/tools/types';
import type {
  ChatCompletion,
  ChatRequest,
  OpenAIToolCall,
  VeniceMessage,
} from '../src/lib/venice';
import type { SupabaseService } from '../src/lib/supabase';

/**
 * Per-round shape the test scripts. The headless loop drives a single
 * non-streaming chat completion per round through
 * `SupabaseService.complete` (the venice/complete edge function).
 * Tests script `{text, toolCalls?}` for each round; the helper fills
 * the rest of the ChatCompletion shape with empty defaults.
 */
interface RoundScript {
  text?: string;
  toolCalls?: OpenAIToolCall[];
}

/**
 * Script a `SupabaseService.complete` mock with one canned
 * ChatCompletion per round. The loop's only network seam is
 * supabase.complete; the toolCtx has no venice slot post worker-
 * fleet sweep.
 */
function makeSupabase(
  rounds: RoundScript[]
): { supabase: SupabaseService; streamCalls: VeniceMessage[][] } {
  // Each round's response comes from rounds[i]; we shift off the front
  // so call 1 sees rounds[0], call 2 sees rounds[1], etc. Naming the
  // observation array `streamCalls` is historical - it captures the
  // per-round message list the loop POSTed.
  const remaining = rounds.slice();
  const streamCalls: VeniceMessage[][] = [];
  const complete = vi.fn(
    async (req: ChatRequest): Promise<ChatCompletion> => {
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
    supabase: { complete } as unknown as SupabaseService,
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

function baseCtx(supabase: SupabaseService): Omit<ToolContext, 'signal'> {
  return {
    supabase,
    userId: 'u',
    threadId: 't',
  };
}

describe('runHeadlessToolLoop — terminal paths', () => {
  it('returns finalText and exits when round 1 has no tool calls', async () => {
    const { supabase } = makeSupabase([{ text: 'hello world' }]);
    const { toolbox, spy } = makeToolbox();

    const result = await runHeadlessToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      toolbox,
      toolCtx: baseCtx(supabase),
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('hello world');
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.stoppedByLimit).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('executes a tool call, feeds the result back, and exits on the next terminal round', async () => {
    const { supabase, streamCalls } = makeSupabase([
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
      model: 'm',
      messages: [{ role: 'user', content: 'please call spy' }],
      toolbox,
      toolCtx: baseCtx(supabase),
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('done');
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    // Round 2's message list must carry the assistant-with-tool-calls
    // row AND the tool-result row — OpenAI rejects a list where a
    // tool_call lacks a matching subsequent role='tool'. The pair must
    // share an id even after the wire-id sanitiser rewrites
    // non-conforming ids ('call-1' has a hyphen and is shorter than 9
    // chars, so both sides land at the same hashed string).
    const r2 = streamCalls[1];
    const assistantRow = r2.find((m) => m.role === 'assistant');
    const toolRow = r2.find((m) => m.role === 'tool');
    expect(assistantRow?.tool_calls?.[0].id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(toolRow?.tool_call_id).toBe(assistantRow?.tool_calls?.[0].id);
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

    const { supabase } = makeSupabase([
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
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
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
    const { supabase, streamCalls } = makeSupabase([
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
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
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
    const { supabase } = makeSupabase([
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
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('recovered');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('runHeadlessToolLoop — abort and limits', () => {
  it('short-circuits with rounds=0 when the signal is already aborted', async () => {
    // No rounds scripted - if the loop calls supabase.complete at all, the
    // default empty response would still drive a tool-less terminal
    // round. The pre-aborted check prevents the call entirely.
    const { supabase } = makeSupabase([]);
    const { toolbox } = makeToolbox();
    const ac = new AbortController();
    ac.abort();

    const result = await runHeadlessToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      toolbox,
      toolCtx: baseCtx(supabase),
      signal: ac.signal,
    });

    expect(result.rounds).toBe(0);
    expect(result.finalText).toBe('');
    expect(supabase.complete).not.toHaveBeenCalled();
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
    const { supabase } = makeSupabase([makeRound('a'), makeRound('b'), makeRound('c')]);
    const { toolbox } = makeToolbox();

    const result = await runHeadlessToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
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
    const { supabase } = makeSupabase([
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
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
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
    const { supabase } = makeSupabase([
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
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
      signal: new AbortController().signal,
    });

    expect(seenDepth).toBe(1);
  });

  it('bumps depth on each level of nesting', async () => {
    // Caller at depth 1 (e.g. an agent's tool that spawned this one)
    // should see its tools running at depth 2.
    let seenDepth: number | undefined = -1;
    const { supabase } = makeSupabase([
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
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: { ...baseCtx(supabase), depth: 1 },
      signal: new AbortController().signal,
    });

    expect(seenDepth).toBe(2);
  });

  it('throws before any Venice call when depth would exceed MAX_AGENT_DEPTH', async () => {
    // Caller already at the cap; the agent we are about to start
    // would run at MAX_AGENT_DEPTH + 1, which is over.
    const { supabase } = makeSupabase([]);
    const { toolbox } = makeToolbox();

    await expect(
      runHeadlessToolLoop({
        model: 'm',
        messages: [{ role: 'user', content: 'go' }],
        toolbox,
        toolCtx: { ...baseCtx(supabase), depth: MAX_AGENT_DEPTH },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/depth limit/);

    expect(supabase.complete).not.toHaveBeenCalled();
  });

  it('allows depth exactly at MAX_AGENT_DEPTH (caller at MAX-1)', async () => {
    // Boundary case: caller depth MAX-1 means the agent runs at MAX.
    // That's the deepest legitimate level - it must not throw.
    const { supabase } = makeSupabase([{ text: 'ok' }]);
    const { toolbox } = makeToolbox();

    const result = await runHeadlessToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      toolbox,
      toolCtx: { ...baseCtx(supabase), depth: MAX_AGENT_DEPTH - 1 },
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe('ok');
  });
});

describe('runHeadlessToolLoop — onProgress live events', () => {
  it('emits a `thinking` event per round and a `tool` event per settled call', async () => {
    const { supabase } = makeSupabase([
      // Round 1: model asks for two parallel tool calls, both with
      // their dispatcher-injected `activity` narrations populated.
      {
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'spy',
              arguments: '{"activity":"searching wiki for Maya","x":1}',
            },
          },
          {
            id: 'c2',
            type: 'function',
            function: {
              name: 'spy',
              arguments: '{"activity":"merging duplicates","x":2}',
            },
          },
        ],
      },
      // Round 2: terminal text-only response.
      { text: 'done' },
    ]);
    const { toolbox } = makeToolbox(async () => ({ ok: true }));

    const events: HeadlessToolLoopEvent[] = [];
    const result = await runHeadlessToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
      signal: new AbortController().signal,
      onProgress: (e) => events.push(e),
    });

    expect(result.toolCalls).toBe(2);
    // Two rounds, so two `thinking` events plus two `tool` events.
    // Parallel tool execution means the order of the two `tool`
    // events within the round isn't fixed - assert by partitioning
    // rather than by index.
    const thinking = events.filter((e) => e.kind === 'thinking');
    const tools = events.filter((e) => e.kind === 'tool');
    expect(thinking.map((e) => (e as { round: number }).round)).toEqual([1, 2]);
    expect(tools).toHaveLength(2);
    expect(tools.every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(
      new Set(tools.map((e) => (e as { activity: string }).activity))
    ).toEqual(new Set(['searching wiki for Maya', 'merging duplicates']));
    // `thinking` for round 1 must precede every `tool` event - the
    // step-list UI relies on this ordering to show "Thinking..." then
    // resolve it as each tool lands.
    expect(events[0].kind).toBe('thinking');
  });

  it('emits a `tool` event with ok=false when the handler throws', async () => {
    const { supabase } = makeSupabase([
      {
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'spy',
              arguments: '{"activity":"deleting Kermit"}',
            },
          },
        ],
      },
      { text: 'done' },
    ]);
    const { toolbox } = makeToolbox(async () => {
      throw new Error('boom');
    });

    const events: HeadlessToolLoopEvent[] = [];
    await runHeadlessToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
      signal: new AbortController().signal,
      onProgress: (e) => events.push(e),
    });

    const toolEvent = events.find((e) => e.kind === 'tool') as
      | { kind: 'tool'; name: string; activity: string; ok: boolean }
      | undefined;
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.ok).toBe(false);
    expect(toolEvent?.activity).toBe('deleting Kermit');
    expect(toolEvent?.name).toBe('spy');
  });

  it('swallows listener errors so the loop keeps running', async () => {
    const { supabase } = makeSupabase([
      {
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'spy', arguments: '{"activity":"a"}' },
          },
        ],
      },
      { text: 'done' },
    ]);
    const { toolbox } = makeToolbox(async () => ({ ok: true }));

    const result = await runHeadlessToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox,
      toolCtx: baseCtx(supabase),
      signal: new AbortController().signal,
      onProgress: () => {
        throw new Error('listener broke');
      },
    });

    expect(result.finalText).toBe('done');
    expect(result.toolCalls).toBe(1);
  });
});
