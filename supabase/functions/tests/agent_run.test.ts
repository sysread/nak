// Behavioral coverage for runHeadlessAgent's injection seam and
// progress hook. The completion override exists precisely so these
// tests can script model rounds without a network; the progress hook
// feeds the Wiki librarian's live step list, and its activity-param
// injection must stay conditional (agents nobody watches live keep
// their wire bytes narration-free).

import { assertEquals } from '@std/assert';
import {
  roundFitsBudget,
  runHeadlessAgent,
  type AgentProgressEvent,
  type Toolbox,
  withProgressNarration,
} from '../venice/agents/_run.ts';
import type { ToolCompletionResult } from '../venice/tools/_venice_complete.ts';

function completion(partial: Partial<ToolCompletionResult>): ToolCompletionResult {
  return {
    text: '',
    reasoning: '',
    citations: [],
    finishReason: 'stop',
    usage: null,
    toolCalls: [],
    ...partial,
  };
}

const ECHO_TOOLBOX: Toolbox = {
  name: 'echo',
  tools: [
    {
      name: 'echo',
      wire: {
        type: 'function',
        function: {
          name: 'echo',
          description: 'echoes',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      },
      // deno-lint-ignore require-await
      execute: async (args) => ({ echoed: args.value }),
    },
  ],
};

// deno-lint-ignore no-explicit-any
const FAKE_BASE_CTX = { adminClient: {} as any, userId: 'u', threadId: 't' };

Deno.test('scripted rounds drive the loop: tool round then terminal text', async () => {
  const calls: Array<{ tools: number }> = [];
  let round = 0;
  const result = await runHeadlessAgent(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox: ECHO_TOOLBOX,
      baseCtx: FAKE_BASE_CTX,
      apiKey: 'k',
      signal: new AbortController().signal,
      // deno-lint-ignore require-await
      complete: async (opts) => {
        calls.push({ tools: (opts.tools ?? []).length });
        round += 1;
        if (round === 1) {
          return completion({
            toolCalls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'echo', arguments: '{"value":"hi"}' },
              },
            ],
          });
        }
        return completion({ text: 'done now' });
      },
    },
    0,
  );
  assertEquals(result.finalText, 'done now');
  assertEquals(result.rounds, 2);
  assertEquals(result.toolCalls, 1);
  assertEquals(calls.length, 2);
});

Deno.test('onProgress emits thinking/tool events; withProgressNarration injects the activity param', async () => {
  const events: AgentProgressEvent[] = [];
  // deno-lint-ignore no-explicit-any
  let wireSeen: any[] = [];
  let round = 0;
  await runHeadlessAgent(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox: withProgressNarration(ECHO_TOOLBOX),
      baseCtx: FAKE_BASE_CTX,
      apiKey: 'k',
      signal: new AbortController().signal,
      onProgress: (e) => events.push(e),
      // deno-lint-ignore require-await
      complete: async (opts) => {
        // deno-lint-ignore no-explicit-any
        wireSeen = [...(opts.tools ?? [])] as any[];
        round += 1;
        if (round === 1) {
          return completion({
            toolCalls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'echo',
                  arguments: '{"value":"hi","activity":"Echoing your value"}',
                },
              },
            ],
          });
        }
        return completion({ text: 'ok' });
      },
    },
    0,
  );
  // Event order: thinking(1), tool, thinking(2). No done event - the
  // resolved Promise is the completion signal.
  assertEquals(events[0], { kind: 'thinking', round: 1 });
  assertEquals(events[1].kind, 'tool');
  if (events[1].kind === 'tool') {
    assertEquals(events[1].name, 'echo');
    assertEquals(events[1].activity, 'Echoing your value');
    assertEquals(events[1].ok, true);
  }
  assertEquals(events[2], { kind: 'thinking', round: 2 });
  // The wire schema the model saw carries the injected activity param,
  // and it is required.
  const params = wireSeen[0].function.parameters as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assertEquals('activity' in params.properties, true);
  assertEquals(params.required.includes('activity'), true);
});

Deno.test('a bare toolbox carries no activity param even with onProgress attached', async () => {
  // deno-lint-ignore no-explicit-any
  let wireSeen: any[] = [];
  await runHeadlessAgent(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox: ECHO_TOOLBOX,
      baseCtx: FAKE_BASE_CTX,
      apiKey: 'k',
      signal: new AbortController().signal,
      // The hook alone must not alter what the model sees - schema
      // narration is opt-in via withProgressNarration only.
      onProgress: () => {},
      // deno-lint-ignore require-await
      complete: async (opts) => {
        // deno-lint-ignore no-explicit-any
        wireSeen = [...(opts.tools ?? [])] as any[];
        return completion({ text: 'ok' });
      },
    },
    0,
  );
  const params = wireSeen[0].function.parameters as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  assertEquals('activity' in params.properties, false);
  assertEquals((params.required ?? []).includes('activity'), false);
});

// ---------------------------------------------------------------------------
// Wall-clock budget. The hosted edge runtime kills an isolate around
// 400s, taking the post-loop outcome write and lease release with it,
// so the loop stops itself first. The clock is injected for the same
// reason `complete` is: these assertions are about the decision, not
// about how fast the test machine runs.

Deno.test('roundFitsBudget: no estimate yet always fits', () => {
  // Round 1 has nothing to extrapolate from and must never be skipped.
  assertEquals(roundFitsBudget(0, 300_000, 0), true);
});

Deno.test('roundFitsBudget: fits while the estimate still leaves room', () => {
  assertEquals(roundFitsBudget(200_000, 300_000, 50_000), true);
  // Exactly filling the budget counts as fitting.
  assertEquals(roundFitsBudget(250_000, 300_000, 50_000), true);
});

Deno.test('roundFitsBudget: refuses a round that would overrun', () => {
  assertEquals(roundFitsBudget(260_000, 300_000, 50_000), false);
  // Already over budget, whatever the estimate.
  assertEquals(roundFitsBudget(400_000, 300_000, 0), false);
});

Deno.test('the loop stops before a round it estimates will not fit', async () => {
  // Clock advances 100s per read. Round 1 therefore measures as 100s
  // against a 250s budget, so round 3 is refused: 200s elapsed + a
  // 100s estimate exceeds it.
  let clock = 0;
  const now = () => {
    clock += 100_000;
    return clock;
  };
  let round = 0;
  const result = await runHeadlessAgent(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox: ECHO_TOOLBOX,
      baseCtx: FAKE_BASE_CTX,
      apiKey: 'k',
      signal: new AbortController().signal,
      budgetMs: 250_000,
      now,
      // Never settles - always asks for another tool call, so only the
      // budget can end this run.
      // deno-lint-ignore require-await
      complete: async () => {
        round += 1;
        return completion({
          toolCalls: [
            {
              id: `c${round}`,
              type: 'function',
              function: { name: 'echo', arguments: '{"value":"hi"}' },
            },
          ],
        });
      },
    },
    0,
  );
  assertEquals(result.stoppedByLimit, true);
  // Stopped on the budget, far short of the 20-round default.
  assertEquals(result.rounds < 20, true);
  // Work already done is kept: each tool call committed as it ran.
  assertEquals(result.toolCalls, result.rounds);
});

Deno.test('an unset budget leaves the loop unbounded by time', async () => {
  // Same never-settling model and a clock jumping an hour per read;
  // without budgetMs the run still goes the full round allowance.
  let clock = 0;
  const now = () => {
    clock += 3_600_000;
    return clock;
  };
  let round = 0;
  const result = await runHeadlessAgent(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox: ECHO_TOOLBOX,
      baseCtx: FAKE_BASE_CTX,
      apiKey: 'k',
      signal: new AbortController().signal,
      now,
      maxRounds: 3,
      // deno-lint-ignore require-await
      complete: async () => {
        round += 1;
        return completion({
          toolCalls: [
            {
              id: `c${round}`,
              type: 'function',
              function: { name: 'echo', arguments: '{"value":"hi"}' },
            },
          ],
        });
      },
    },
    0,
  );
  assertEquals(result.rounds, 3);
  assertEquals(result.stoppedByLimit, true);
});

Deno.test('a budget too small for one round still runs one', async () => {
  // Zero budget must not produce a zero-round result; callers treat a
  // completed run as having done at least something.
  let clock = 0;
  const now = () => {
    clock += 100_000;
    return clock;
  };
  const result = await runHeadlessAgent(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox: ECHO_TOOLBOX,
      baseCtx: FAKE_BASE_CTX,
      apiKey: 'k',
      signal: new AbortController().signal,
      budgetMs: 0,
      now,
      // deno-lint-ignore require-await
      complete: async () => completion({ text: 'settled' }),
    },
    0,
  );
  assertEquals(result.rounds, 1);
  assertEquals(result.finalText, 'settled');
});
