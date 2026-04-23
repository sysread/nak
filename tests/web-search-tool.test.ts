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
  ChatRequest,
  StreamEvent,
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

function mkVenice(handler: (req: ChatRequest) => StreamEvent[]): {
  venice: VeniceClient;
  seen: ChatRequest[];
} {
  const seen: ChatRequest[] = [];
  const streamChat = vi.fn(async function* (req: ChatRequest): AsyncGenerator<
    StreamEvent,
    void,
    void
  > {
    seen.push(req);
    for (const ev of handler(req)) yield ev;
  });
  return {
    venice: { streamChat, embed: vi.fn() } as unknown as VeniceClient,
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
    const { venice } = mkVenice(() => []);
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
    const { venice, seen } = mkVenice(() => [
      { type: 'text', delta: 'bitcoin is at ~$70k ' },
      { type: 'text', delta: 'today^1^.' },
      {
        type: 'citations',
        citations: [
          { index: 1, url: 'https://example.com/btc', title: 'BTC price' },
        ],
      },
    ]);
    await webSearch.execute({ query: 'current price of bitcoin' }, ctxFor(venice));
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.model).toBe(VENICE_WEB_SEARCH_MODEL);
    expect(req.webSearch).toBe('on');
    expect(req.webCitations).toBe(true);
    // The tool caps its sub-call — a runaway multi-round synthesis is
    // a tool bug. The exact number is a soft contract; just ensure we
    // set some cap rather than handing the model unbounded completion.
    expect(typeof req.maxTokens).toBe('number');
  });

  it('returns { answer, citations } with concatenated text deltas', async () => {
    const citations: Citation[] = [
      { index: 1, url: 'https://example.com/a', title: 'A' },
      { index: 2, url: 'https://example.com/b' },
    ];
    const { venice } = mkVenice(() => [
      { type: 'text', delta: 'part one ' },
      { type: 'text', delta: 'part two' },
      { type: 'citations', citations },
    ]);
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
    // Not every query triggers Venice's web-search payload — some
    // topics the backend doesn't surface sources for. The tool must
    // still return a well-shaped result so the chat-loop's citation
    // harvester sees `citations: []` and does nothing rather than
    // choking on an absent field.
    const { venice } = mkVenice(() => [{ type: 'text', delta: 'nothing to cite' }]);
    const result = await webSearch.execute({ query: 'x' }, ctxFor(venice));
    expect(result).toEqual({ answer: 'nothing to cite', citations: [] });
  });

  it('forwards context_hint into the user turn when provided', async () => {
    const { venice, seen } = mkVenice(() => [{ type: 'text', delta: 'ok' }]);
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
    const { venice, seen } = mkVenice(() => [{ type: 'text', delta: 'ok' }]);
    await webSearch.execute({ query: 'q' }, ctxFor(venice));
    const userMsg = seen[0].messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('Query: q');
  });

  it('propagates ctx.signal into the sub-call so cancellation cascades', async () => {
    // A user aborting the outer send must cascade through into the
    // sub-completion. The tool is required to pass the ctx.signal
    // through verbatim, not spin up an unrelated controller.
    const { venice, seen } = mkVenice(() => [{ type: 'text', delta: 'ok' }]);
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
