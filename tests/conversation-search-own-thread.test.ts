/**
 * Own-thread exclusion coverage for conversation_search. Mirrors the
 * sole-source filter tests for wiki_search; pins that the tool reads
 * `ctx.conversationExcludeOwnThread` and drops hits whose `thread.id`
 * equals `ctx.threadId` only when the flag is set.
 *
 * Previously this exclusion was unconditional with an LLM-facing
 * `include_current: true` opt-out; now it is harness-controlled via
 * ctx. The arg is gone from the schema entirely - the model has no
 * say in whether its own conversation echoes back.
 */
import { describe, it, expect, vi } from 'vitest';
import { conversationSearch } from '../src/lib/tools/conversation_search';
import { conversationSearchSchema } from '../src/lib/tools/conversation_search.schema';
import type {
  SupabaseService,
  Thread,
  ThreadSearchHit,
  ThreadSummaryRow,
} from '../src/lib/supabase';
import type { ToolContext } from '../src/lib/tools';
import type { VeniceClient } from '../src/lib/venice';

function makeThread(id: string, title: string): Thread {
  return {
    id,
    user_id: 'u-1',
    title,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    model: null,
    reasoning_effort: null,
    verbosity: null,
    summary: `summary of ${title}`,
  } as unknown as Thread;
}

function makeHit(id: string, title: string): ThreadSearchHit {
  return {
    thread: makeThread(id, title),
    kind: 'semantic',
    similarity: 0.5,
  };
}

function makeSupabaseMock(opts: { hits: ThreadSearchHit[] }): SupabaseService {
  const summaries: ThreadSummaryRow[] = opts.hits.map(
    (h) =>
      ({
        id: h.thread.id,
        title: h.thread.title,
        summary: `summary of ${h.thread.title}`,
      }) as ThreadSummaryRow
  );
  return {
    searchThreads: vi.fn().mockResolvedValue(opts.hits),
    listThreadSummariesByIds: vi.fn().mockResolvedValue(summaries),
  } as unknown as SupabaseService;
}

function makeVeniceMock(): VeniceClient {
  return {
    embed: vi.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }),
  } as unknown as VeniceClient;
}

function makeCtx(opts: {
  flag: boolean | undefined;
  threadId: string;
  hits: ThreadSearchHit[];
}): ToolContext {
  return {
    supabase: makeSupabaseMock({ hits: opts.hits }),
    venice: makeVeniceMock(),
    userId: 'u-1',
    threadId: opts.threadId,
    signal: new AbortController().signal,
    depth: 0,
    ...(opts.flag !== undefined
      ? { conversationExcludeOwnThread: opts.flag }
      : {}),
  };
}

describe('conversation_search own-thread exclusion via ctx flag', () => {
  it('with the ctx flag set, drops the hit whose id matches ctx.threadId', async () => {
    const ctx = makeCtx({
      flag: true,
      threadId: 't-current',
      hits: [makeHit('t-current', 'Self'), makeHit('t-other', 'Other')],
    });
    const out = (await conversationSearch.execute(
      { query: 'whatever' },
      ctx
    )) as Array<{ id: string }>;
    expect(out.map((r) => r.id)).toEqual(['t-other']);
  });

  it('with the ctx flag absent, returns every hit including the current thread', async () => {
    const ctx = makeCtx({
      flag: undefined,
      threadId: 't-current',
      hits: [makeHit('t-current', 'Self'), makeHit('t-other', 'Other')],
    });
    const out = (await conversationSearch.execute(
      { query: 'whatever' },
      ctx
    )) as Array<{ id: string }>;
    expect(out.map((r) => r.id)).toEqual(['t-current', 't-other']);
  });

  it('with the ctx flag false, returns every hit including the current thread', async () => {
    const ctx = makeCtx({
      flag: false,
      threadId: 't-current',
      hits: [makeHit('t-current', 'Self'), makeHit('t-other', 'Other')],
    });
    const out = (await conversationSearch.execute(
      { query: 'whatever' },
      ctx
    )) as Array<{ id: string }>;
    expect(out.map((r) => r.id)).toEqual(['t-current', 't-other']);
  });

  it('overfetches by one when the flag is set so a self-hit drop preserves the limit', async () => {
    const ctx = makeCtx({
      flag: true,
      threadId: 't-current',
      hits: [makeHit('t-current', 'Self'), makeHit('t-other', 'Other')],
    });
    await conversationSearch.execute({ query: 'whatever', limit: 1 }, ctx);
    const searchCall = (
      ctx.supabase.searchThreads as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    // The caller asked for 1; with the filter on we overfetched to 2
    // so a single self-exclusion still leaves a usable result.
    expect(searchCall.limit).toBe(2);
  });
});

describe('conversation_search schema', () => {
  it('no longer advertises an include_current arg (harness-controlled now)', () => {
    const props = conversationSearchSchema.parameters.properties as Record<
      string,
      unknown
    >;
    expect(props).not.toHaveProperty('include_current');
    // The remaining args are the LLM-controllable ones: query and limit.
    expect(Object.keys(props).sort()).toEqual(['limit', 'query']);
  });
});
