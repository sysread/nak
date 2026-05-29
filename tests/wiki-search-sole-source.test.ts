/**
 * Sole-source exclusion coverage for wiki search. Pins two layers:
 *
 *   - `searchWikiArticlesSemantic` (src/lib/wiki.ts): when
 *     `excludeSoleSourceThreadId` is set, articles whose only row in
 *     `wiki_article_sources` is that thread get dropped. Articles with
 *     multiple sources, orphan articles (absent from the sources map),
 *     and the unfiltered branch (param absent) all pass through.
 *
 *   - `wikiSearch.execute` (src/lib/tools/wiki_search.ts): the tool
 *     reads `ctx.wikiExcludeOwnThreadSoleSources` and threads
 *     `ctx.threadId` through as the exclusion. Flag absent or false
 *     leaves the search call unfiltered.
 *
 * Both layers go through plain mocks of SupabaseService - the ILIKE
 * fallback path is taken because the mock has no `embed`, so the query
 * embed throws and the search degrades (no embed round-trip is needed
 * for the filter logic this file pins).
 */
import { describe, it, expect, vi } from 'vitest';
import { searchWikiArticlesSemantic } from '../src/lib/wiki';
import { wikiSearch } from '../src/lib/tools/wiki_search';
import type { SupabaseService, WikiArticle } from '../src/lib/supabase';
import type { ToolContext } from '../src/lib/tools';
import type { VeniceClient } from '../src/lib/venice';

function makeArticle(id: string, title: string): WikiArticle {
  return {
    id,
    title,
    content: `body of ${title}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeSupabaseMock(opts: {
  rows: WikiArticle[];
  sources: Map<string, Set<string>>;
}): SupabaseService {
  return {
    searchWikiArticles: vi.fn().mockResolvedValue(opts.rows),
    listSourceThreadIdsForArticles: vi.fn().mockResolvedValue(opts.sources),
  } as unknown as SupabaseService;
}

describe('searchWikiArticlesSemantic sole-source filter', () => {
  it('returns every row unfiltered when excludeSoleSourceThreadId is absent', async () => {
    const rows = [makeArticle('a1', 'A1'), makeArticle('a2', 'A2')];
    const supabase = makeSupabaseMock({
      rows,
      sources: new Map([['a1', new Set(['t-current'])]]),
    });

    const out = await searchWikiArticlesSemantic('q', 10, {
      supabase,
    });

    expect(out.map((a) => a.id)).toEqual(['a1', 'a2']);
    // No sources lookup happens when the filter is off.
    expect(
      (supabase.listSourceThreadIdsForArticles as ReturnType<typeof vi.fn>).mock
        .calls.length
    ).toBe(0);
  });

  it('drops an article whose only source is the excluded thread', async () => {
    const rows = [makeArticle('a1', 'A1'), makeArticle('a2', 'A2')];
    const supabase = makeSupabaseMock({
      rows,
      sources: new Map([
        ['a1', new Set(['t-current'])],
        ['a2', new Set(['t-other'])],
      ]),
    });

    const out = await searchWikiArticlesSemantic('q', 10, {
      supabase,
      excludeSoleSourceThreadId: 't-current',
    });

    expect(out.map((a) => a.id)).toEqual(['a2']);
  });

  it('keeps an article when the excluded thread is one of several sources', async () => {
    const rows = [makeArticle('a1', 'A1')];
    const supabase = makeSupabaseMock({
      rows,
      sources: new Map([['a1', new Set(['t-current', 't-other'])]]),
    });

    const out = await searchWikiArticlesSemantic('q', 10, {
      supabase,
      excludeSoleSourceThreadId: 't-current',
    });

    expect(out.map((a) => a.id)).toEqual(['a1']);
  });

  it('keeps an orphan article (no rows in the sources map) under the filter', async () => {
    const rows = [makeArticle('orphan', 'Orphan')];
    const supabase = makeSupabaseMock({
      rows,
      // 'orphan' deliberately absent: articles with zero source rows
      // never echo a single thread back to itself, so they pass through.
      sources: new Map(),
    });

    const out = await searchWikiArticlesSemantic('q', 10, {
      supabase,
      excludeSoleSourceThreadId: 't-current',
    });

    expect(out.map((a) => a.id)).toEqual(['orphan']);
  });

  it('overfetches under the filter so trimming preserves the requested limit', async () => {
    // Caller asks for 2; the search layer should request 2 + overfetch
    // so a single sole-source drop still leaves 2 rows for the caller.
    const rows = [
      makeArticle('drop', 'Drop'),
      makeArticle('keep1', 'Keep1'),
      makeArticle('keep2', 'Keep2'),
    ];
    const supabase = makeSupabaseMock({
      rows,
      sources: new Map([['drop', new Set(['t-current'])]]),
    });

    const out = await searchWikiArticlesSemantic('q', 2, {
      supabase,
      excludeSoleSourceThreadId: 't-current',
    });

    expect(out.map((a) => a.id)).toEqual(['keep1', 'keep2']);
    // The supabase call was issued with the overfetched limit, not the
    // caller's bare limit - pinning so a future regression doesn't
    // silently reintroduce under-fetch.
    const searchCall = (
      supabase.searchWikiArticles as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(searchCall.limit).toBeGreaterThan(2);
  });
});

describe('wikiSearch tool ctx wiring', () => {
  function makeCtx(flag: boolean | undefined): ToolContext {
    const supabase = makeSupabaseMock({
      rows: [makeArticle('a1', 'A1')],
      sources: new Map([['a1', new Set(['ctx-thread'])]]),
    });
    return {
      supabase,
      venice: { embed: vi.fn() } as unknown as VeniceClient,
      userId: 'u-1',
      threadId: 'ctx-thread',
      signal: new AbortController().signal,
      depth: 0,
      ...(flag !== undefined ? { wikiExcludeOwnThreadSoleSources: flag } : {}),
    };
  }

  it('with the ctx flag set, drops the article whose sole source is ctx.threadId', async () => {
    const ctx = makeCtx(true);
    const out = (await wikiSearch.execute({ query: 'whatever' }, ctx)) as Array<{
      id: string;
    }>;
    expect(out.map((a) => a.id)).toEqual([]);
  });

  it('with the ctx flag absent, returns the article unfiltered', async () => {
    const ctx = makeCtx(undefined);
    const out = (await wikiSearch.execute({ query: 'whatever' }, ctx)) as Array<{
      id: string;
    }>;
    expect(out.map((a) => a.id)).toEqual(['a1']);
  });

  it('with the ctx flag false, returns the article unfiltered', async () => {
    const ctx = makeCtx(false);
    const out = (await wikiSearch.execute({ query: 'whatever' }, ctx)) as Array<{
      id: string;
    }>;
    expect(out.map((a) => a.id)).toEqual(['a1']);
  });
});
