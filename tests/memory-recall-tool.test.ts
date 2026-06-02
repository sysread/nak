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
import type { ChatCompletion } from '../src/lib/venice';

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

function ctxFor(svc: SupabaseService): ToolContext {
  // venice is optional on ToolContext post-recall-family migration; the
  // chat loop still populates it in production for wiki_librarian, but
  // memory_recall doesn't reach for it.
  return {
    supabase: svc,
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

  it('description scopes recall vs search by use case', () => {
    // The earlier wording told the model to "STRONGLY PREFER" recall
    // over memory_search; that framing was dropped when memory_search
    // moved to always-on. memory_search is now a peer tool the model
    // should reach for on direct lookups (including "what do you
    // remember about me" questions), while memory_recall is for the
    // topic-boundary stale-context use case. The description has to
    // spell out both halves so the model picks the right tool.
    expect(memoryRecall.description).toMatch(/recall/i);
    expect(memoryRecall.description).toMatch(/memory_search/);
    // Topic-boundary or stale-context cue - the lever that escalates
    // recall over a direct search.
    expect(memoryRecall.description).toMatch(/new topic|stale|context/i);
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
    // The tool synthesises a RecallAgent with ctx.supabase and calls
    // run(). A scripted supabase.complete drives the agent to a
    // parsed note (the chat-completion seam moved off venice in
    // milestone 6, and the recall-family sweep dropped the leftover
    // venice constructor arg); the tool returns that note directly
    // so the chat-loop's JSON.stringify of the tool-result body is a
    // clean `{"kind":"note","note":"…"}` on the wire.
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'how do I deploy' }),
    ];
    const listMessages = vi.fn(async () => messages);
    const complete = vi.fn(async () =>
      makeCompletion(
        '{"kind":"note","note":"I remember the app deploys via Cloudflare Pages."}'
      )
    );
    const svc = { listMessages, complete } as unknown as SupabaseService;

    const result = await memoryRecall.execute({}, ctxFor(svc));

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
    const complete = vi.fn(async () => makeCompletion('{"kind":"none"}'));
    const svc = {
      listMessages: vi.fn(async () => messages),
      complete,
    } as unknown as SupabaseService;

    const result = await memoryRecall.execute({}, ctxFor(svc));
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
      complete: vi.fn(),
    } as unknown as SupabaseService;

    const result = await memoryRecall.execute({}, ctxFor(svc));
    expect(result).toEqual({ kind: 'none' });
  });
});
