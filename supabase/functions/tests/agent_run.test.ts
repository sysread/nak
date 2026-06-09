// Behavioral coverage for runHeadlessAgent's injection seam and
// progress hook. The completion override exists precisely so these
// tests can script model rounds without a network; the progress hook
// feeds the Wiki librarian's live step list, and its activity-param
// injection must stay conditional (agents nobody watches live keep
// their wire bytes narration-free).

import { assertEquals } from '@std/assert';
import {
  runHeadlessAgent,
  type AgentProgressEvent,
  type Toolbox,
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

Deno.test('onProgress emits thinking/tool events and injects the activity param', async () => {
  const events: AgentProgressEvent[] = [];
  // deno-lint-ignore no-explicit-any
  let wireSeen: any[] = [];
  let round = 0;
  await runHeadlessAgent(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolbox: ECHO_TOOLBOX,
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

Deno.test('without onProgress the wire schemas carry no activity param', async () => {
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
