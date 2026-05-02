/**
 * Unit coverage for the `web_search` tool. The tool wraps a one-shot
 * sub-completion against Venice with `enable_web_search=on` and
 * `enable_web_citations=true`; the chat-loop harvests the returned
 * citations and merges them onto the terminal assistant row. This test
 * file exercises the tool surface directly: shape of the request it
 * fires, shape of the return value, and its registry placement.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  memoryToolbox,
  recallToolbox,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import { webSearch } from '../src/lib/tools/web_search';
import { VENICE_WEB_SEARCH_MODEL } from '../src/lib/models';
import type { SupabaseService } from '../src/lib/supabase';
import type {
  ChatCompletion,
  ChatRequest,
  VeniceClient,
  Citation,
} from '../src/lib/venice';

function ctxFor(venice: VeniceClient): ToolContext {
  return {
    supabase: {} as SupabaseService,
    venice,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

function makeCompletion(text: string, citations: Citation[] = []): ChatCompletion {
  return {
    text,
    reasoning: '',
    toolCalls: [],
    usage: null,
    citations,
    finishReason: 'stop',
  };
}

function mkVenice(handler: (req: ChatRequest) => ChatCompletion): {
  venice: VeniceClient;
  seen: ChatRequest[];
} {
  const seen: ChatRequest[] = [];
  const completeChat = vi.fn(async (req: ChatRequest): Promise<ChatCompletion> => {
    seen.push(req);
    return handler(req);
  });
  return {
    venice: { completeChat, embed: vi.fn() } as unknown as VeniceClient,
    seen,
  };
}

describe('web_search — registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('web_search');
  });

  it('is absent from memoryToolbox — reflection agent must not reach for live web data', () => {
    // Reflection runs on conversation-internal tasks; a web fetch inside
    // a memory-mutation pipeline would burn search quota and contaminate
    // memories with scraped results.
    expect(memoryToolbox.tools.map((t) => t.name)).not.toContain('web_search');
  });

  it('is absent from recallToolbox — recall agent must not reach for live web data', () => {
    // Recall reads the user's own memories and the live thread. A web
    // search inside recall would be a new failure mode, not a feature.
    expect(recallToolbox.tools.map((t) => t.name)).not.toContain('web_search');
  });

  it('requires a `query` parameter, treats `context_hint` as optional', () => {
    // The schema is what the model sees. Keep `additionalProperties`
    // locked to false so a future model that hallucinates extra fields
    // doesn't silently smuggle them into the sub-call.
    expect(webSearch.parameters).toEqual({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: expect.stringMatching(/search[- ]engine/i),
        },
        context_hint: {
          type: 'string',
          description: expect.stringMatching(/caller context|sub-search/i),
        },
      },
      required: ['query'],
      additionalProperties: false,
    });
  });
});

describe('web_search — execute() shape', () => {
  it('throws on an empty or missing query', async () => {
    const { venice } = mkVenice(() => makeCompletion(''));
    await expect(
      webSearch.execute({} as Record<string, unknown>, ctxFor(venice))
    ).rejects.toThrow(/non-empty.*query/i);
    await expect(
      webSearch.execute({ query: '' }, ctxFor(venice))
    ).rejects.toThrow(/non-empty.*query/i);
    await expect(
      webSearch.execute({ query: '   ' }, ctxFor(venice))
    ).rejects.toThrow(/non-empty.*query/i);
  });

  it('fires a sub-completion with webSearch=on, webCitations=true, fast-tier model', async () => {
    const { venice, seen } = mkVenice(() =>
      makeCompletion('bitcoin is at ~$70k today^1^.', [
        { index: 1, url: 'https://example.com/btc', title: 'BTC price' },
      ])
    );
    await webSearch.execute({ query: 'current price of bitcoin' }, ctxFor(venice));
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.model).toBe(VENICE_WEB_SEARCH_MODEL);
    expect(req.webSearch).toBe('on');
    expect(req.webCitations).toBe(true);
    // Reasoning is pinned to 'low' and maxTokens is sized for the
    // headroom a reasoning-model preamble eats - both load-bearing.
    // The fast tier is currently a reasoning model that emits its
    // chain-of-thought through `reasoning_content` BEFORE writing
    // answer text into `content`. With the previous 400-token cap
    // and default effort, the budget got consumed by the CoT and
    // the model hit `finish_reason: 'length'` with zero `content`,
    // surfacing as the "no answer text" error every call. Lock both
    // the effort and the cap so a future revert to 400 / 'medium'
    // re-introduces the regression visibly.
    expect(req.reasoningEffort).toBe('low');
    expect(req.maxTokens).toBeGreaterThanOrEqual(1000);
  });

  it('returns { answer, citations } from the completion result', async () => {
    const citations: Citation[] = [
      { index: 1, url: 'https://example.com/a', title: 'A' },
      { index: 2, url: 'https://example.com/b' },
    ];
    const { venice } = mkVenice(() => makeCompletion('part one part two', citations));
    const result = await webSearch.execute(
      { query: 'who won the 2024 election' },
      ctxFor(venice)
    );
    expect(result).toEqual({
      answer: 'part one part two',
      citations,
    });
  });

  it('returns an empty citations array when Venice emitted none', async () => {
    // Not every query triggers Venice's web-search payload - some
    // topics the backend doesn't surface sources for. The tool must
    // still return a well-shaped result so the chat-loop's citation
    // harvester sees `citations: []` and does nothing rather than
    // choking on an absent field.
    const { venice } = mkVenice(() => makeCompletion('nothing to cite'));
    const result = await webSearch.execute({ query: 'x' }, ctxFor(venice));
    expect(result).toEqual({ answer: 'nothing to cite', citations: [] });
  });

  it('throws a descriptive error when the sub-agent completion produces no text', async () => {
    // Empty-completion failure mode: the sub-call returned but the
    // `text` field was empty. Without this throw, the tool would
    // silently return `{answer: '', citations: []}` - indistinguishable
    // from a successful "no results" answer, leaving the calling LLM
    // no way to tell whether to retry, rephrase, or surface the
    // failure to the user. The throw routes through chat-loop's
    // encodeToolContent into `{error: "..."}` on the tool-result row.
    const { venice } = mkVenice(() => makeCompletion(''));
    await expect(
      webSearch.execute({ query: 'q' }, ctxFor(venice))
    ).rejects.toThrow(/no answer text/i);
  });

  it('throws on whitespace-only completion output', async () => {
    // Tripwire on the trim() check: a completion that contains only
    // whitespace is the same failure shape as a fully empty result
    // from the calling LLM's perspective.
    const { venice } = mkVenice(() => makeCompletion('   \n\n'));
    await expect(
      webSearch.execute({ query: 'q' }, ctxFor(venice))
    ).rejects.toThrow(/no answer text/i);
  });

  it('throws when only citations arrive without any answer prose', async () => {
    // The backend can return citations without the model emitting any
    // text (e.g. content filter trimmed the synthesis). Citations
    // alone are not a usable tool result - the calling LLM gets no
    // synthesis to relay or build on - so we surface this as an
    // error rather than handing back a bare citation list.
    const { venice } = mkVenice(() =>
      makeCompletion('', [{ index: 1, url: 'https://example.com/a' }])
    );
    await expect(
      webSearch.execute({ query: 'q' }, ctxFor(venice))
    ).rejects.toThrow(/no answer text/i);
  });

  it('forwards context_hint into the user turn when provided', async () => {
    const { venice, seen } = mkVenice(() => makeCompletion('ok'));
    await webSearch.execute(
      {
        query: 'latest llm release',
        context_hint:
          'User is asking whether a new Claude model dropped this week.',
      },
      ctxFor(venice)
    );
    const userMsg = seen[0].messages.find((m) => m.role === 'user');
    const content = typeof userMsg?.content === 'string' ? userMsg.content : '';
    expect(content).toContain(
      'User is asking whether a new Claude model dropped this week.'
    );
    expect(content).toContain('Query: latest llm release');
  });

  it('omits the context_hint preamble when absent', async () => {
    const { venice, seen } = mkVenice(() => makeCompletion('ok'));
    await webSearch.execute({ query: 'q' }, ctxFor(venice));
    const userMsg = seen[0].messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('Query: q');
  });

  it('propagates ctx.signal into the sub-call so cancellation cascades', async () => {
    // A user aborting the outer send must cascade through into the
    // sub-completion. The tool is required to pass the ctx.signal
    // through verbatim, not spin up an unrelated controller.
    const { venice, seen } = mkVenice(() => makeCompletion('ok'));
    const ctl = new AbortController();
    const ctx: ToolContext = {
      supabase: {} as SupabaseService,
      venice,
      userId: 'u-1',
      threadId: 't-1',
      signal: ctl.signal,
    };
    await webSearch.execute({ query: 'q' }, ctx);
    expect(seen[0].signal).toBe(ctl.signal);
  });
});
