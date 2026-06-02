/**
 * Unit coverage for WikiAgent's content-classifier fallback path. The
 * loop tests already exercise the worker state machine with a mocked
 * agent, and the agent's happy path is implicitly covered there;
 * what we verify here is the agent-internal retry that swaps the
 * model id from the configured wiki slot to the uncensored fallback
 * when Venice rejects the request body with the content-classifier
 * sentinel.
 */
import { describe, it, expect, vi } from 'vitest';
import { WikiAgent, isContentFilterRejection } from '../src/lib/agents/wiki/agent';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type {
  ChatCompletion,
  ChatRequest,
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

/**
 * Build a Supabase stub for the wiki agent's needs. The chat-
 * completion seam moved to `supabase.complete` in milestone 6 - pass
 * the per-round handler as `complete`, or omit it for tests that
 * never reach the chat-completion path.
 */
function makeSupabase(
  messages: Message[],
  complete?: (req: ChatRequest) => Promise<ChatCompletion>
): SupabaseService {
  return {
    listMessages: vi.fn(async () => messages),
    // The wiki toolbox would reach for these if the model issued a
    // tool call. The scripted complete handler returns a terminal text
    // round every time so the tool path is not exercised here.
    searchWikiArticles: vi.fn(async () => []),
    createWikiArticle: vi.fn(async () => ({ id: 'w-1' })),
    updateWikiArticle: vi.fn(async () => undefined),
    deleteWikiArticle: vi.fn(async () => undefined),
    // retrySkippedThread reaches these.
    computeWikiTerminalMsgId: vi.fn(async () => 'a-default'),
    manualAdvanceWikiPointer: vi.fn(async () => undefined),
    complete: complete ? vi.fn(complete) : vi.fn(),
  } as unknown as SupabaseService;
}

/**
 * Convenience: build a `supabase.complete` handler that throws for
 * the primary model with the content-classifier sentinel and returns
 * a happy terminal response for the fallback. Lets the agent's two-
 * shot retry path resolve in a single test step.
 */
function makeFilterCompleteOnPrimary(
  primaryModel: string,
  fallbackModel: string,
  fallbackText: string
): {
  complete: (req: ChatRequest) => Promise<ChatCompletion>;
  calls: { model: string }[];
} {
  const calls: { model: string }[] = [];
  const complete = async (
    req: { model: string; messages: VeniceMessage[] }
  ): Promise<ChatCompletion> => {
    calls.push({ model: req.model });
    if (req.model === primaryModel) {
      throw new Error(
        'Venice HTTP 400: {"error":"Input text data may contain inappropriate content.","request_id":"abc"}'
      );
    }
    if (req.model === fallbackModel) {
      return {
        text: fallbackText,
        reasoning: '',
        toolCalls: [],
        usage: null,
        citations: [],
        finishReason: 'stop',
      };
    }
    throw new Error(`unexpected model ${req.model}`);
  };
  return { complete, calls };
}

describe('isContentFilterRejection', () => {
  it('matches the exact Venice content-classifier sentinel', () => {
    const err = new Error(
      'Venice HTTP 400: {"error":"Input text data may contain inappropriate content."}'
    );
    expect(isContentFilterRejection(err)).toBe(true);
  });

  it('matches when the sentinel is embedded in a longer message', () => {
    expect(
      isContentFilterRejection(
        'something something Input text data may contain inappropriate content something'
      )
    ).toBe(true);
  });

  it('does NOT match a generic HTTP 400 without the sentinel', () => {
    const err = new Error('Venice HTTP 400: {"error":"unknown param"}');
    expect(isContentFilterRejection(err)).toBe(false);
  });

  it('does NOT match a network error', () => {
    expect(isContentFilterRejection(new Error('ECONNRESET'))).toBe(false);
  });

  it('handles null and undefined safely', () => {
    expect(isContentFilterRejection(null)).toBe(false);
    expect(isContentFilterRejection(undefined)).toBe(false);
  });
});

describe('WikiAgent - content-classifier fallback', () => {
  it('retries with the uncensored fallback when the primary is filter-rejected', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'tell me about my dog' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'Got it.' }),
    ];
    const { complete, calls } = makeFilterCompleteOnPrimary(
      'deepseek-v4-flash',
      'arcee-trinity-large-thinking',
      'Fallback ran, no edits warranted.'
    );
    const svc = makeSupabase(messages, complete);
    const agent = new WikiAgent(svc, 'deepseek-v4-flash');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('done');
    expect(result.output.finalText).toBe('Fallback ran, no edits warranted.');
    // Order matters: primary first, fallback second. A reversed order
    // would mean the agent skipped the configured model entirely.
    expect(calls.map((c) => c.model)).toEqual([
      'deepseek-v4-flash',
      'arcee-trinity-large-thinking',
    ]);
  });

  it('does NOT retry on a non-content-filter error', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];
    const calls: { model: string }[] = [];
    const svc = makeSupabase(messages, async (req) => {
      calls.push({ model: req.model });
      throw new Error('Venice HTTP 500: gateway error');
    });
    const agent = new WikiAgent(svc, 'deepseek-v4-flash');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('error');
    expect(result.error).toContain('Venice HTTP 500');
    // One call: the primary. The fallback path is content-filter-only.
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('deepseek-v4-flash');
  });

  it('returns the fallback error when both attempts fail', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];
    const calls: { model: string }[] = [];
    const svc = makeSupabase(messages, async (req) => {
      calls.push({ model: req.model });
      if (req.model === 'deepseek-v4-flash') {
        throw new Error(
          'Venice HTTP 400: {"error":"Input text data may contain inappropriate content."}'
        );
      }
      throw new Error('arcee timeout');
    });
    const agent = new WikiAgent(svc, 'deepseek-v4-flash');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('error');
    // Surface the FALLBACK's error - the primary's classifier rejection
    // is no longer the headline once we've moved past it.
    expect(result.error).toContain('arcee timeout');
    expect(calls.map((c) => c.model)).toEqual([
      'deepseek-v4-flash',
      'arcee-trinity-large-thinking',
    ]);
  });

  it('skips the fallback when the configured model IS the fallback', async () => {
    // Defensive: if a future config pinned the wiki slot to the
    // uncensored model directly, the agent should NOT retry against
    // itself (wasted call, identical body, identical outcome).
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];
    const calls: { model: string }[] = [];
    const svc = makeSupabase(messages, async (req) => {
      calls.push({ model: req.model });
      throw new Error(
        'Venice HTTP 400: {"error":"Input text data may contain inappropriate content."}'
      );
    });
    const agent = new WikiAgent(svc, 'arcee-trinity-large-thinking');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('error');
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('arcee-trinity-large-thinking');
  });
});

describe('WikiAgent.retrySkippedThread', () => {
  it('resolves the terminal id, runs the agent, advances the pointer on done', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];
    const { complete } = makeFilterCompleteOnPrimary(
      'deepseek-v4-flash',
      'arcee-trinity-large-thinking',
      'Recovered on the fallback.'
    );
    const svc = makeSupabase(messages, complete);
    // Override the default mock so we can assert it was called with
    // the specific thread id the test passes in.
    (svc.computeWikiTerminalMsgId as ReturnType<typeof vi.fn>).mockResolvedValue(
      'a1'
    );
    const agent = new WikiAgent(svc, 'deepseek-v4-flash');

    const result = await agent.retrySkippedThread({
      threadId: 't-1',
      userId: 'u',
    });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.terminalMsgId).toBe('a1');
      // Tool-call count + reasoning are part of the success result
      // so the panel can surface "0 edits - here's why" or
      // "3 edits landed - here's what" without dropping the row
      // silently. Zero tool calls is a legitimate done outcome.
      expect(result.toolCalls).toBe(0);
      expect(result.reasoning).toBe('Recovered on the fallback.');
    }
    expect(svc.computeWikiTerminalMsgId).toHaveBeenCalledWith('t-1');
    expect(svc.manualAdvanceWikiPointer).toHaveBeenCalledWith('t-1', 'a1');
  });

  it('falls back to "(none)" reasoning when the model returned an empty final text', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];
    const svc = makeSupabase(messages, async () => ({
      text: '   \n   ',
      reasoning: '',
      toolCalls: [],
      usage: null,
      citations: [],
      finishReason: 'stop',
    }));
    (svc.computeWikiTerminalMsgId as ReturnType<typeof vi.fn>).mockResolvedValue(
      'a1'
    );
    const agent = new WikiAgent(svc, 'deepseek-v4-flash');

    const result = await agent.retrySkippedThread({
      threadId: 't-2',
      userId: 'u',
    });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.reasoning).toBe('(none)');
    }
  });

  it('returns no-op (without calling the chat-completion edge) when the thread has no anchor', async () => {
    const svc = makeSupabase([], async () => {
      throw new Error('should not have been called');
    });
    (svc.computeWikiTerminalMsgId as ReturnType<typeof vi.fn>).mockResolvedValue(
      null
    );
    const agent = new WikiAgent(svc, 'deepseek-v4-flash');

    const result = await agent.retrySkippedThread({
      threadId: 't-empty',
      userId: 'u',
    });

    expect(result.kind).toBe('no-op');
    expect(svc.complete).not.toHaveBeenCalled();
    expect(svc.manualAdvanceWikiPointer).not.toHaveBeenCalled();
  });

  it('returns the agent error and does NOT advance the pointer when both attempts fail', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];
    const svc = makeSupabase(messages, async () => {
      throw new Error('Venice HTTP 500: upstream');
    });
    (svc.computeWikiTerminalMsgId as ReturnType<typeof vi.fn>).mockResolvedValue(
      'a1'
    );
    const agent = new WikiAgent(svc, 'deepseek-v4-flash');

    const result = await agent.retrySkippedThread({
      threadId: 't-1',
      userId: 'u',
    });

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toContain('Venice HTTP 500');
    }
    // Critical: the skip marker stays put (we did not advance the
    // pointer), so the user keeps seeing the row in the Skipped panel.
    expect(svc.manualAdvanceWikiPointer).not.toHaveBeenCalled();
  });

  it('surfaces a pointer-advance failure even after a successful agent run', async () => {
    const messages: Message[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];
    const svc = makeSupabase(messages, async () => ({
      text: 'done',
      reasoning: '',
      toolCalls: [],
      usage: null,
      citations: [],
      finishReason: 'stop',
    }));
    (svc.computeWikiTerminalMsgId as ReturnType<typeof vi.fn>).mockResolvedValue(
      'a1'
    );
    (svc.manualAdvanceWikiPointer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('RPC blew up')
    );
    const agent = new WikiAgent(svc, 'deepseek-v4-flash');

    const result = await agent.retrySkippedThread({
      threadId: 't-1',
      userId: 'u',
    });

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toContain('pointer-advance failed');
      expect(result.error).toContain('RPC blew up');
    }
  });
});
