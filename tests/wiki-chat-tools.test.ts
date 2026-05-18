/**
 * Unit coverage for the three wiki tools exposed to the main chat
 * model: wiki_list (always-on read), wiki_get (always-on read), and
 * wiki_librarian (gated delegate that fans out to the librarian sub-
 * agent). The librarian path is wrapped over `runManually` from
 * `wiki-librarian/runner.svelte`; we mock that module so the test
 * exercises the tool's wiring (settings fetch, arg validation, error
 * unwrapping) without driving a real Venice round-trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wikiList } from '../src/lib/tools/wiki_list';
import { wikiGet } from '../src/lib/tools/wiki_get';
import { WIKI_LIST_EXCERPT_CHARS } from '../src/lib/tools/wiki_list.schema';
import type { ToolContext } from '../src/lib/tools/types';
import type { SupabaseService, WikiArticle, UserSettings } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';

// Mock the librarian runner module so wiki_librarian's execute() can be
// driven end-to-end without spinning the real agent. `vi.mock` is
// hoisted, so the mock is in place before the tool's import resolves.
vi.mock('../src/lib/agents/wiki-librarian/runner.svelte', () => ({
  runManually: vi.fn(),
}));

import { wikiLibrarian } from '../src/lib/tools/wiki_librarian';
import { runManually } from '../src/lib/agents/wiki-librarian/runner.svelte';

function article(id: string, title: string, content: string): WikiArticle {
  return {
    id,
    title,
    content,
    created_at: '2026-05-12T00:00:00Z',
    updated_at: '2026-05-12T00:00:00Z',
  };
}

interface Spies {
  listWikiArticles: ReturnType<typeof vi.fn>;
  getWikiArticleById: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
}

function mockSupabase(opts: {
  articles?: WikiArticle[];
  byId?: Record<string, WikiArticle | null>;
  settings?: Partial<UserSettings>;
} = {}): { svc: SupabaseService; spies: Spies } {
  const articles = opts.articles ?? [];
  const byId = opts.byId ?? {};
  const settings = opts.settings ?? {};
  const spies: Spies = {
    listWikiArticles: vi.fn(async ({ limit }: { limit?: number } = {}) =>
      articles.slice(0, limit ?? 500)
    ),
    getWikiArticleById: vi.fn(async (id: string) => byId[id] ?? null),
    getSettings: vi.fn(async () => settings as UserSettings),
  };
  const svc = spies as unknown as SupabaseService;
  return { svc, spies };
}

function ctxFor(svc: SupabaseService): ToolContext {
  return {
    supabase: svc,
    venice: {} as VeniceClient,
    userId: 'user-1',
    threadId: 'thread-1',
    signal: new AbortController().signal,
  };
}

describe('wiki_list', () => {
  it('returns id + title + truncated excerpt for each article', async () => {
    const longBody = 'x'.repeat(WIKI_LIST_EXCERPT_CHARS + 500);
    const { svc, spies } = mockSupabase({
      articles: [
        article('a-1', 'Apple', 'A short body.'),
        article('a-2', 'Banana', longBody),
      ],
    });
    const result = (await wikiList.execute({}, ctxFor(svc))) as Array<{
      id: string;
      title: string;
      excerpt: string;
    }>;
    expect(spies.listWikiArticles).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { id: 'a-1', title: 'Apple', excerpt: 'A short body.' },
      {
        id: 'a-2',
        title: 'Banana',
        excerpt: longBody.slice(0, WIKI_LIST_EXCERPT_CHARS),
      },
    ]);
  });

  it('clamps an oversize limit down to the schema max', async () => {
    const { svc, spies } = mockSupabase();
    await wikiList.execute({ limit: 10_000 }, ctxFor(svc));
    expect(spies.listWikiArticles).toHaveBeenCalledWith({ limit: 500 });
  });

  it('floors a fractional limit and rejects values below 1', async () => {
    const { svc, spies } = mockSupabase();
    await wikiList.execute({ limit: 0.5 }, ctxFor(svc));
    expect(spies.listWikiArticles).toHaveBeenLastCalledWith({ limit: 1 });
    await wikiList.execute({ limit: 7.9 }, ctxFor(svc));
    expect(spies.listWikiArticles).toHaveBeenLastCalledWith({ limit: 7 });
  });

  it('applies the default limit when the arg is missing', async () => {
    const { svc, spies } = mockSupabase();
    await wikiList.execute({}, ctxFor(svc));
    expect(spies.listWikiArticles).toHaveBeenCalledWith({ limit: 100 });
  });
});

describe('wiki_get', () => {
  it('returns {found: true, article} on a hit', async () => {
    const a = article('a-1', 'Maya', 'long form body about Maya');
    const { svc, spies } = mockSupabase({ byId: { 'a-1': a } });
    const result = (await wikiGet.execute({ id: 'a-1' }, ctxFor(svc))) as {
      found: boolean;
      article: WikiArticle;
    };
    expect(spies.getWikiArticleById).toHaveBeenCalledWith('a-1');
    expect(result.found).toBe(true);
    expect(result.article.title).toBe('Maya');
    expect(result.article.content).toBe('long form body about Maya');
  });

  it('returns {found: false} when the id is unknown', async () => {
    const { svc } = mockSupabase({ byId: {} });
    const result = await wikiGet.execute({ id: 'nope' }, ctxFor(svc));
    expect(result).toEqual({ found: false });
  });

  it('rejects an empty id with a structured error', async () => {
    const { svc } = mockSupabase();
    await expect(wikiGet.execute({ id: '' }, ctxFor(svc))).rejects.toThrow(
      /id is required/i
    );
    await expect(wikiGet.execute({ id: '   ' }, ctxFor(svc))).rejects.toThrow(
      /id is required/i
    );
  });
});

describe('wiki_librarian', () => {
  beforeEach(() => {
    vi.mocked(runManually).mockReset();
  });

  it('passes instructions, profile, and ctx fields through to runManually', async () => {
    const { svc } = mockSupabase({
      settings: { userName: 'Mira', userLocation: 'Halifax' },
    });
    vi.mocked(runManually).mockResolvedValue({
      kind: 'ok',
      finalText: 'Merged the two Maya pages; left "household" alone.',
      toolCalls: 3,
      articleCount: 14,
    });

    const ctx = ctxFor(svc);
    const result = (await wikiLibrarian.execute(
      { instructions: 'Merge the two Maya articles into one.' },
      ctx
    )) as { summary: string; articleCount: number; toolCalls: number };

    expect(runManually).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runManually).mock.calls[0][0];
    expect(call.userId).toBe('user-1');
    expect(call.userName).toBe('Mira');
    expect(call.userLocation).toBe('Halifax');
    expect(call.customInstructions).toBe(
      'Merge the two Maya articles into one.'
    );
    expect(call.supabase).toBe(svc);
    expect(call.signal).toBe(ctx.signal);

    expect(result).toEqual({
      summary: 'Merged the two Maya pages; left "household" alone.',
      articleCount: 14,
      toolCalls: 3,
    });
  });

  it('trims whitespace and rejects an empty instructions arg', async () => {
    const { svc } = mockSupabase({ settings: {} });
    await expect(
      wikiLibrarian.execute({ instructions: '   ' }, ctxFor(svc))
    ).rejects.toThrow(/non-empty `instructions`/);
    expect(runManually).not.toHaveBeenCalled();
  });

  it('defaults missing profile fields to empty strings (librarian collapses to no-profile block)', async () => {
    const { svc } = mockSupabase({ settings: {} });
    vi.mocked(runManually).mockResolvedValue({
      kind: 'ok',
      finalText: '',
      toolCalls: 0,
      articleCount: 0,
    });
    await wikiLibrarian.execute(
      { instructions: 'Tidy up the project pages.' },
      ctxFor(svc)
    );
    const call = vi.mocked(runManually).mock.calls[0][0];
    expect(call.userName).toBe('');
    expect(call.userLocation).toBe('');
  });

  it('unwraps a librarian error into a thrown Error so chat-loop surfaces it', async () => {
    const { svc } = mockSupabase({ settings: {} });
    vi.mocked(runManually).mockResolvedValue({
      kind: 'error',
      finalText: '',
      toolCalls: 0,
      articleCount: 0,
      error: 'A manual librarian run is already in flight.',
    });
    await expect(
      wikiLibrarian.execute(
        { instructions: 'Delete the kettle stub.' },
        ctxFor(svc)
      )
    ).rejects.toThrow(/already in flight/);
  });

  it('throws with a fallback message when an error result lacks an error string', async () => {
    const { svc } = mockSupabase({ settings: {} });
    vi.mocked(runManually).mockResolvedValue({
      kind: 'error',
      finalText: '',
      toolCalls: 0,
      articleCount: 0,
    });
    await expect(
      wikiLibrarian.execute(
        { instructions: 'Delete the kettle stub.' },
        ctxFor(svc)
      )
    ).rejects.toThrow(/run failed without an error message/);
  });
});
