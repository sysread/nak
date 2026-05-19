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

function makeSupabase(messages: Message[]): SupabaseService {
  return {
    listMessages: vi.fn(async () => messages),
    // The wiki toolbox would reach for these if the model issued a
    // tool call. Our scripted venice returns a terminal text round
    // every time so the tool path is not exercised here.
    searchWikiArticles: vi.fn(async () => []),
    createWikiArticle: vi.fn(async () => ({ id: 'w-1' })),
    updateWikiArticle: vi.fn(async () => undefined),
    deleteWikiArticle: vi.fn(async () => undefined),
  } as unknown as SupabaseService;
}

/**
 * Convenience: build a venice whose `completeChat` throws for the
 * primary model with the content-classifier sentinel, and returns a
 * happy terminal response for the fallback. Lets the agent's two-shot
 * retry path resolve in a single test step.
 */
function makeVeniceWithFilterOnPrimary(
  primaryModel: string,
  fallbackModel: string,
  fallbackText: string
): {
  venice: VeniceClient;
  calls: { model: string }[];
} {
  const calls: { model: string }[] = [];
  const completeChat = vi.fn(
    async (req: { model: string; messages: VeniceMessage[] }): Promise<ChatCompletion> => {
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
    }
  );
  return {
    venice: {
      completeChat,
      embed: vi.fn(async () => ({ data: [] })),
    } as unknown as VeniceClient,
    calls,
  };
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
    const svc = makeSupabase(messages);
    const { venice, calls } = makeVeniceWithFilterOnPrimary(
      'deepseek-v4-flash',
      'arcee-trinity-large-thinking',
      'Fallback ran, no edits warranted.'
    );
    const agent = new WikiAgent(venice, svc, 'deepseek-v4-flash');

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
    const svc = makeSupabase(messages);
    const calls: { model: string }[] = [];
    const completeChat = vi.fn(
      async (req: { model: string }): Promise<ChatCompletion> => {
        calls.push({ model: req.model });
        throw new Error('Venice HTTP 500: gateway error');
      }
    );
    const venice = {
      completeChat,
      embed: vi.fn(async () => ({ data: [] })),
    } as unknown as VeniceClient;
    const agent = new WikiAgent(venice, svc, 'deepseek-v4-flash');

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
    const svc = makeSupabase(messages);
    const calls: { model: string }[] = [];
    const completeChat = vi.fn(
      async (req: { model: string }): Promise<ChatCompletion> => {
        calls.push({ model: req.model });
        if (req.model === 'deepseek-v4-flash') {
          throw new Error(
            'Venice HTTP 400: {"error":"Input text data may contain inappropriate content."}'
          );
        }
        throw new Error('arcee timeout');
      }
    );
    const venice = {
      completeChat,
      embed: vi.fn(async () => ({ data: [] })),
    } as unknown as VeniceClient;
    const agent = new WikiAgent(venice, svc, 'deepseek-v4-flash');

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
    const svc = makeSupabase(messages);
    const calls: { model: string }[] = [];
    const completeChat = vi.fn(
      async (req: { model: string }): Promise<ChatCompletion> => {
        calls.push({ model: req.model });
        throw new Error(
          'Venice HTTP 400: {"error":"Input text data may contain inappropriate content."}'
        );
      }
    );
    const venice = {
      completeChat,
      embed: vi.fn(async () => ({ data: [] })),
    } as unknown as VeniceClient;
    const agent = new WikiAgent(venice, svc, 'arcee-trinity-large-thinking');

    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'a1' },
      userId: 'u',
    });

    expect(result.stoppedReason).toBe('error');
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('arcee-trinity-large-thinking');
  });
});
