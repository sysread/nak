/**
 * Unit coverage for RecallAgent — the class, not the tool that invokes
 * it. We verify:
 *
 *   - the agent fetches thread history, trims to the last user turn
 *     (so an in-flight tool-call assistant row from the calling loop
 *     doesn't leak into recall's messages), appends RECALL_PROMPT,
 *     and forwards the response_format constraint.
 *   - it pins `recallToolbox` (read-only — no memory_create / _update /
 *     _invalidate / _delete), so a bug in the prompt can't mutate
 *     long-term memory from this agent.
 *   - the final-text JSON gets parsed into a typed RecallNote, with
 *     `{kind:'none'}` as the safe fallback on malformed / empty /
 *     unexpected payloads.
 *   - aborted and errored runs return well-formed AgentRunResult
 *     objects (no thrown exceptions at the agent boundary).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  RecallAgent,
  trimToLastUserTurn,
  parseRecallOutput,
} from '../src/lib/agents/recall/agent';
import { RECALL_PROMPT } from '../src/lib/agents/recall/prompt';
import { recallToolbox } from '../src/lib/tools/recall_toolbox';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type {
  ChatCompletion,
  OpenAIToolCall,
  VeniceClient,
  VeniceMessage,
} from '../src/lib/venice';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'm',
    thread_id: 't-1',
    role: 'user',
    content: 'hi',
    created_at: '2024-01-01T00:00:00Z',
    tool_calls: null,
    tool_call_id: null,
    name: null,
    model: null,
    usage: null,
    ...overrides,
  } as Message;
}

function makeSupabase(messages: Message[]): {
  svc: SupabaseService;
  spies: { listMessages: ReturnType<typeof vi.fn> };
} {
  const spies = {
    listMessages: vi.fn(async () => messages),
    // Recall toolbox only exposes memory_search, which goes through
    // the RPC helpers below. Memory_create / _update / _invalidate
    // are deliberately absent — a test that accidentally routes to
    // them should fail on the missing method, not succeed silently.
    searchMemories: vi.fn(async () => []),
    searchMemoriesByEmbedding: vi.fn(async () => []),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

/**
 * Scripted venice whose `completeChat` returns a canned response per
 * round. `streamCalls` captures every call's full request so tests can
 * inspect messages AND the response_format / tools fields.
 */
interface RecordedStreamCall {
  messages: VeniceMessage[];
  responseFormat: unknown;
  toolNames: string[];
}

interface RoundScript {
  text?: string;
  toolCalls?: OpenAIToolCall[];
}

function makeVenice(rounds: RoundScript[]): {
  venice: VeniceClient;
  streamCalls: RecordedStreamCall[];
} {
  const remaining = rounds.slice();
  const streamCalls: RecordedStreamCall[] = [];
  const completeChat = vi.fn(
    async (req: {
      messages: VeniceMessage[];
      responseFormat?: unknown;
      tools?: Array<{ function: { name: string } }>;
    }): Promise<ChatCompletion> => {
      streamCalls.push({
        messages: req.messages.map((m) => ({ ...m })),
        responseFormat: req.responseFormat,
        toolNames: (req.tools ?? []).map((t) => t.function.name),
      });
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
    venice: {
      completeChat,
      // Embedding calls happen inside memory_search; stub a 1024-dim
      // vector so any round that routes through searchMemoriesByEmbedding
      // doesn't explode on the tool-side Math.
      embed: vi.fn(async () => ({
        data: [{ index: 0, embedding: new Array(1024).fill(0) }],
      })),
    } as unknown as VeniceClient,
    streamCalls,
  };
}

describe('trimToLastUserTurn', () => {
  it('drops an in-flight assistant tool_calls row added by the caller', () => {
    // Exactly the shape listMessages returns when `memory_recall` is
    // invoked from the chat loop: the assistant row carrying the
    // tool_call has already been persisted, but the matching tool-
    // result row hasn't — sending that state to Venice is an API
    // error. The trim hides the assistant row so the recall model
    // sees a valid history ending at the user.
    const messages = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
      makeMessage({ id: 'u2', role: 'user', content: 'tell me more' }),
      makeMessage({
        id: 'a2',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'memory_recall', arguments: '{}' } },
        ],
      }),
    ];
    const trimmed = trimToLastUserTurn(messages);
    expect(trimmed).toHaveLength(3);
    expect(trimmed[trimmed.length - 1].id).toBe('u2');
  });

  it('returns an empty array when no user turn is present', () => {
    const messages = [
      makeMessage({ id: 'a1', role: 'assistant', content: 'auto-greeting' }),
    ];
    expect(trimToLastUserTurn(messages)).toEqual([]);
  });

  it('keeps the whole history when it already ends at a user turn', () => {
    const messages = [
      makeMessage({ id: 'u1', role: 'user', content: 'a' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'b' }),
      makeMessage({ id: 'u2', role: 'user', content: 'c' }),
    ];
    expect(trimToLastUserTurn(messages)).toHaveLength(3);
  });
});

describe('parseRecallOutput', () => {
  it('parses the empty signal', () => {
    expect(parseRecallOutput('{"kind":"none"}')).toEqual({ kind: 'none' });
  });

  it('parses the note signal and trims whitespace', () => {
    expect(parseRecallOutput('{"kind":"note","note":"  hi there  "}')).toEqual({
      kind: 'note',
      note: 'hi there',
    });
  });

  it('strips a ```json``` code fence the model may have added', () => {
    // Some providers honour json_object as "valid JSON" but still
    // wrap the payload in a fence when the system prompt leans on
    // markdown. The parser has to tolerate this because the fence is
    // not something we can fix from the prompt alone.
    const fenced = '```json\n{"kind":"note","note":"x"}\n```';
    expect(parseRecallOutput(fenced)).toEqual({ kind: 'note', note: 'x' });
  });

  it('collapses malformed JSON to the empty signal with a parse-failed reason', () => {
    // The diagnostic `reason` field rides along on every empty
    // signal so a "memory_recall keeps emitting empty" debugging
    // session can tell parse failures apart from "the model
    // legitimately decided nothing was relevant." See agent.ts.
    expect(parseRecallOutput('not json')).toEqual({
      kind: 'none',
      reason: 'JSON parse failed',
    });
  });

  it('collapses an unknown kind to the empty signal with a schema-mismatch reason', () => {
    expect(parseRecallOutput('{"kind":"injection"}')).toEqual({
      kind: 'none',
      reason: 'response did not match expected schema',
    });
  });

  it('collapses note missing a string note field to the empty signal', () => {
    expect(parseRecallOutput('{"kind":"note"}')).toEqual({
      kind: 'none',
      reason: 'response did not match expected schema',
    });
    expect(parseRecallOutput('{"kind":"note","note":""}')).toEqual({
      kind: 'none',
      reason: 'response did not match expected schema',
    });
  });

  it('handles empty input', () => {
    expect(parseRecallOutput('')).toEqual({
      kind: 'none',
      reason: 'empty model output',
    });
    expect(parseRecallOutput('   ')).toEqual({
      kind: 'none',
      reason: 'empty model output',
    });
  });

  it('preserves a model-supplied reason on {kind:"none"}', () => {
    // The prompt instructs the model to include a short diagnostic
    // reason when emitting the empty signal (see prompt.ts). The
    // parser passes it through verbatim so the tool-result panel
    // and log drawer can show what the agent actually tried.
    expect(
      parseRecallOutput('{"kind":"none","reason":"no memories matched"}')
    ).toEqual({ kind: 'none', reason: 'no memories matched' });
  });

  it('drops an empty / non-string reason rather than letting it ride', () => {
    expect(parseRecallOutput('{"kind":"none","reason":""}')).toEqual({
      kind: 'none',
    });
    expect(parseRecallOutput('{"kind":"none","reason":42}')).toEqual({
      kind: 'none',
    });
  });
});

describe('RecallAgent — identity + contract', () => {
  it('advertises the recall toolbox (read-only), recall name, and a model id', () => {
    const { svc } = makeSupabase([]);
    const { venice } = makeVenice([]);
    const agent = new RecallAgent(venice, svc);
    expect(agent.name).toBe('recall');
    expect(agent.toolbox).toBe(recallToolbox);
    expect(agent.model.length).toBeGreaterThan(0);
  });

  it('advertises only memory_search in its toolbox — no write tools', () => {
    const toolNames = recallToolbox.tools.map((t) => t.name);
    expect(toolNames).toEqual(['memory_search']);
  });

  it('accepts a model override for tests and future A/B runs', () => {
    const { svc } = makeSupabase([]);
    const { venice } = makeVenice([]);
    const agent = new RecallAgent(venice, svc, 'custom-test-model');
    expect(agent.model).toBe('custom-test-model');
  });
});

describe('RecallAgent — run() happy path', () => {
  it('trims the in-flight assistant tool_calls row, appends RECALL_PROMPT, pins json_object response_format, and parses a note', async () => {
    const messages: Message[] = [
      makeMessage({
        id: 'u1',
        role: 'user',
        content: 'I just moved to Lisbon',
        created_at: '2024-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: 'Nice, what do you like about it?',
        created_at: '2024-01-01T00:00:01Z',
      }),
      makeMessage({
        id: 'u2',
        role: 'user',
        content: 'need a dentist recommendation',
        created_at: '2024-01-01T00:00:02Z',
      }),
      // The in-flight assistant row that triggered the recall tool.
      // trimToLastUserTurn has to hide it so Venice gets a valid
      // history.
      makeMessage({
        id: 'a2',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'memory_recall', arguments: '{}' } },
        ],
      }),
    ];
    const { svc } = makeSupabase(messages);
    const { venice, streamCalls } = makeVenice([
      {
        text: '{"kind":"note","note":"I remember the user already has a dentist back home."}',
      },
    ]);
    const agent = new RecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('done');
    expect(result.output.note).toEqual({
      kind: 'note',
      note: 'I remember the user already has a dentist back home.',
    });
    expect(result.output.inputMessageCount).toBe(3); // u1, a1, u2 — a2 trimmed

    const call = streamCalls[0];
    // Prompt is appended as the trailing user turn; the in-flight
    // assistant row isn't in the messages we sent.
    expect(call.messages).toHaveLength(4);
    expect(call.messages[call.messages.length - 1]).toEqual({
      role: 'user',
      content: RECALL_PROMPT,
    });
    expect(call.messages.some((m) => m.tool_calls && m.tool_calls.length > 0)).toBe(false);

    // response_format pinned to json_object so providers that honour
    // the hint constrain their text output.
    expect(call.responseFormat).toEqual({ type: 'json_object' });

    // Toolbox is read-only — only memory_search is on the wire. A
    // prompt bug can't route into memory_create / update / invalidate
    // because those tools aren't in the recall toolbox at all.
    expect(call.toolNames).toEqual(['memory_search']);
  });

  it('returns an empty-kind note when the model emits the no-op signal', async () => {
    const { svc } = makeSupabase([
      makeMessage({ id: 'u1', role: 'user', content: 'what time is it' }),
    ]);
    const { venice } = makeVenice([{ text: '{"kind":"none"}' }]);
    const agent = new RecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.output.note).toEqual({ kind: 'none' });
    expect(result.output.rawText).toBe('{"kind":"none"}');
  });

  it('falls back to {kind:"none"} when the model returns malformed JSON', async () => {
    const { svc } = makeSupabase([
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
    ]);
    const { venice } = makeVenice([
      { text: 'I could not remember anything.' },
    ]);
    const agent = new RecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    // The raw text is preserved for debugging, and the structured
    // note collapses to the safe fallback (with a `reason` field
    // for the log drawer / tool-result panel) so the main model
    // sees "nothing to inject" rather than a parse error, and a
    // sustained "always emits empty" diagnostic loop has a signal
    // to read.
    expect(result.stoppedReason).toBe('done');
    expect(result.output.note).toEqual({
      kind: 'none',
      reason: 'JSON parse failed',
    });
    expect(result.output.rawText).toBe('I could not remember anything.');
  });
});

describe('RecallAgent — edge cases', () => {
  it('short-circuits on a pre-aborted signal without calling Supabase or Venice', async () => {
    const { svc } = makeSupabase([
      makeMessage({ id: 'u1', role: 'user', content: 'x' }),
    ]);
    const { venice } = makeVenice([]);
    const agent = new RecallAgent(venice, svc, 'test-model');
    const ac = new AbortController();
    ac.abort();

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
      signal: ac.signal,
    });

    expect(result.stoppedReason).toBe('aborted');
    expect(svc.listMessages).not.toHaveBeenCalled();
    expect(venice.completeChat).not.toHaveBeenCalled();
  });

  it('returns done with an empty note when no user turn is in the thread', async () => {
    // Pathological: the first row is an assistant greeting. Nothing
    // to recall against, and we avoid a wasted Venice call by
    // short-circuiting before completeChat.
    const { svc } = makeSupabase([
      makeMessage({ id: 'a1', role: 'assistant', content: 'auto-greet' }),
    ]);
    const { venice } = makeVenice([]);
    const agent = new RecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('done');
    expect(result.output.note).toEqual({ kind: 'none' });
    expect(result.output.inputMessageCount).toBe(0);
    expect(venice.completeChat).not.toHaveBeenCalled();
  });

  it('captures a thrown error and returns stoppedReason=error with a message', async () => {
    const svc = {
      listMessages: vi.fn(async () => {
        throw new Error('network flaked');
      }),
    } as unknown as SupabaseService;
    const { venice } = makeVenice([]);
    const agent = new RecallAgent(venice, svc, 'test-model');

    const result = await agent.run({
      input: { threadId: 't-1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('error');
    expect(result.error).toMatch(/network flaked/);
    expect(result.output.note).toEqual({ kind: 'none' });
  });
});
