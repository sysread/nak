/**
 * Unit coverage for the `memory_recall` tool. This is a light test
 * layer — the heavy lifting is in `recall-agent.test.ts`. Here we
 * check the tool surface itself:
 *
 *   - present in the main chat TOOLS list (model can see it);
 *   - absent from both memoryToolbox and recallToolbox (so the
 *     reflection agent and the recall agent itself can't recurse
 *     into a nested recall pass);
 *   - description is strongly worded about preferring recall over
 *     search for context-gathering (the "strong wording" the design
 *     calls for is testable — grep the description);
 *   - execute() routes through RecallAgent and hands the parsed note
 *     back as the tool result.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  memoryToolbox,
  recallToolbox,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import { memoryRecall } from '../src/lib/tools/memory_recall';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type { ChatCompletion, VeniceClient } from '../src/lib/venice';

function makeCompletion(text: string): ChatCompletion {
  return {
    text,
    reasoning: '',
    toolCalls: [],
    usage: null,
    citations: [],
    finishReason: 'stop',
  };
}

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

function ctxFor(svc: SupabaseService, venice: VeniceClient): ToolContext {
  return {
    supabase: svc,
    venice,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

describe('memory_recall — registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('memory_recall');
  });

  it('is absent from memoryToolbox — reflection agent must not get recall', () => {
    // A reflection agent that can trigger a recall pass would spawn
    // a second agent from inside a background agent. The design
    // explicitly forbids this; the test is the tripwire.
    expect(memoryToolbox.tools.map((t) => t.name)).not.toContain('memory_recall');
  });

  it('is absent from recallToolbox — the recall agent must not recurse', () => {
    expect(recallToolbox.tools.map((t) => t.name)).not.toContain('memory_recall');
  });

  it('description strongly prefers recall over memory_search for context gathering', () => {
    // Grep the description for the load-bearing phrasing. If someone
    // softens the wording to something like "consider using recall",
    // this assertion points at the fact that the design called for
    // a strong preference.
    const desc = memoryRecall.description.toUpperCase();
    expect(desc).toMatch(/STRONGLY PREFER/);
    // It should also spell out the exception — memory_search is for
    // user-directed mutations, not for casual recall.
    expect(memoryRecall.description).toMatch(/memory_search/);
    expect(memoryRecall.description).toMatch(/memory_update|memory_delete|memory_invalidate/);
  });

  it('takes no arguments — the tool uses ctx.threadId, not a user-provided id', () => {
    // Keeping the parameter schema empty means the model can't pass
    // the wrong thread id. The conversation id flows through the
    // ToolContext that the chat-loop populates.
    expect(memoryRecall.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('memory_recall — execute() routes through RecallAgent', () => {
  it('returns the parsed RecallNote as the tool result on the happy path', async () => {
    // The tool synthesises a RecallAgent with ctx.venice + ctx.supabase
    // and calls run(). A scripted Venice stream drives the agent to a
    // parsed note; the tool returns that note directly so the chat-
    // loop's JSON.stringify of the tool-result body is a clean
    // `{"kind":"note","note":"…"}` on the wire.
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'how do I deploy' }),
    ];
    const listMessages = vi.fn(async () => messages);
    const svc = { listMessages } as unknown as SupabaseService;

    const completeChat = vi.fn(async () =>
      makeCompletion(
        '{"kind":"note","note":"I remember the app deploys via Cloudflare Pages."}'
      )
    );
    const venice = { completeChat, embed: vi.fn() } as unknown as VeniceClient;

    const result = await memoryRecall.execute({}, ctxFor(svc, venice));

    expect(result).toEqual({
      kind: 'note',
      note: 'I remember the app deploys via Cloudflare Pages.',
    });
    expect(listMessages).toHaveBeenCalledWith('t-1');
  });

  it('returns {kind:"none"} when the agent signals nothing worth injecting', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'what time is it' }),
    ];
    const svc = {
      listMessages: vi.fn(async () => messages),
    } as unknown as SupabaseService;
    const completeChat = vi.fn(async () => makeCompletion('{"kind":"none"}'));
    const venice = { completeChat, embed: vi.fn() } as unknown as VeniceClient;

    const result = await memoryRecall.execute({}, ctxFor(svc, venice));
    expect(result).toEqual({ kind: 'none' });
  });

  it('does not surface an agent error as a thrown tool error — collapses to {kind:"none"}', async () => {
    // An agent that can't recall should not break the main chat. The
    // tool returns the safe fallback so the main model sees "nothing
    // to inject" and carries on rather than seeing a tool error that
    // might prompt a retry loop.
    const svc = {
      listMessages: vi.fn(async () => {
        throw new Error('supabase flaked');
      }),
    } as unknown as SupabaseService;
    const venice = {
      completeChat: vi.fn(),
      embed: vi.fn(),
    } as unknown as VeniceClient;

    const result = await memoryRecall.execute({}, ctxFor(svc, venice));
    expect(result).toEqual({ kind: 'none' });
  });
});
