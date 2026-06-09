/**
 * Unit coverage for the browser wiki_update tool's source-attribution
 * path - the one wiki write impl still dispatched browser-side (by
 * the wiki librarian; the autonomous agent's create/update/delete run
 * server-side in the venice function now, with their own port of this
 * logic). The librarian's wiki_update accepts a `source_thread_ids`
 * parameter and validates each id against the threads table before
 * attaching; a non-empty ctx.threadId is trusted directly.
 *
 * These tests stub SupabaseService at the method surface so the
 * actual DB never gets hit; they exist to lock down the dispatch
 * choices the tool makes given its ctx.threadId + args shape.
 */
import { describe, it, expect, vi } from 'vitest';
import { wikiUpdate } from '../src/lib/tools/wiki_update';
import type { ToolContext } from '../src/lib/tools/types';
import type { SupabaseService, WikiArticle } from '../src/lib/supabase';

function fakeArticle(id: string, content = 'body'): WikiArticle {
  return {
    id,
    title: 'Title',
    content,
    created_at: '2026-05-12T00:00:00Z',
    updated_at: '2026-05-12T00:00:00Z',
  };
}

interface Spies {
  updateWikiArticle: ReturnType<typeof vi.fn>;
  attachWikiArticleSources: ReturnType<typeof vi.fn>;
  findExistingThreadIds: ReturnType<typeof vi.fn>;
}

function mockSupabase(opts: { knownThreadIds?: string[] } = {}): {
  svc: SupabaseService;
  spies: Spies;
} {
  const known = new Set(opts.knownThreadIds ?? []);
  const spies: Spies = {
    updateWikiArticle: vi.fn(async (id: string) => fakeArticle(id)),
    attachWikiArticleSources: vi.fn(async () => undefined),
    findExistingThreadIds: vi.fn(async (ids: readonly string[]) => {
      const out = new Set<string>();
      for (const id of ids) if (known.has(id)) out.add(id);
      return out;
    }),
  };
  // A minimal shape adequate for the wiki tool's surface; cast through
  // unknown to satisfy the SupabaseService interface without stubbing
  // every method.
  const svc = spies as unknown as SupabaseService;
  return { svc, spies };
}

function ctxFor(svc: SupabaseService, threadId: string): ToolContext {
  return {
    supabase: svc,
    userId: 'user-1',
    threadId,
    signal: new AbortController().signal,
  };
}

describe('wiki_update source attribution', () => {
  it('attaches a non-empty ctx.threadId after a successful update', async () => {
    const { svc, spies } = mockSupabase();
    const ctx = ctxFor(svc, 'thread-abc');
    await wikiUpdate.execute(
      { id: 'art-1', content: 'new body', message: 'tweak body' },
      ctx
    );
    expect(spies.updateWikiArticle).toHaveBeenCalledTimes(1);
    expect(spies.attachWikiArticleSources).toHaveBeenCalledTimes(1);
    expect(spies.attachWikiArticleSources).toHaveBeenCalledWith('art-1', [
      'thread-abc',
    ]);
  });

  it('librarian: validates source_thread_ids and attaches only known ones', async () => {
    const { svc, spies } = mockSupabase({ knownThreadIds: ['t-real-1', 't-real-2'] });
    const ctx = ctxFor(svc, ''); // librarian: empty threadId
    await wikiUpdate.execute(
      {
        id: 'art-1',
        content: 'new body',
        message: 'tweak body',
        source_thread_ids: ['t-real-1', 't-real-2', 't-fake'],
      },
      ctx
    );
    expect(spies.findExistingThreadIds).toHaveBeenCalledWith([
      't-real-1',
      't-real-2',
      't-fake',
    ]);
    expect(spies.attachWikiArticleSources).toHaveBeenCalledTimes(1);
    const [, ids] = spies.attachWikiArticleSources.mock.calls[0] as [
      string,
      string[],
    ];
    expect(new Set(ids)).toEqual(new Set(['t-real-1', 't-real-2']));
  });

  it('librarian: drops all source_thread_ids silently when none are known', async () => {
    const { svc, spies } = mockSupabase({ knownThreadIds: [] });
    const ctx = ctxFor(svc, '');
    await wikiUpdate.execute(
      {
        id: 'art-1',
        content: 'new body',
        message: 'tweak body',
        source_thread_ids: ['t-fake-1', 't-fake-2'],
      },
      ctx
    );
    expect(spies.attachWikiArticleSources).not.toHaveBeenCalled();
  });

  it('combines a non-empty ctx.threadId with validated source_thread_ids', async () => {
    // Defensive shape: a thread-scoped wiki_update where the model also
    // happens to pass source_thread_ids. The tool should merge ctx.threadId
    // with the validated ids; we trust the ctx thread directly,
    // we validate the model-supplied ids.
    const { svc, spies } = mockSupabase({ knownThreadIds: ['t-extra'] });
    const ctx = ctxFor(svc, 'thread-abc');
    await wikiUpdate.execute(
      {
        id: 'art-1',
        content: 'new body',
        message: 'tweak body',
        source_thread_ids: ['t-extra', 't-fake'],
      },
      ctx
    );
    expect(spies.attachWikiArticleSources).toHaveBeenCalledTimes(1);
    const [, ids] = spies.attachWikiArticleSources.mock.calls[0] as [
      string,
      string[],
    ];
    expect(new Set(ids)).toEqual(new Set(['thread-abc', 't-extra']));
  });

  it('manual-like (no threadId, no source_thread_ids): attaches nothing', async () => {
    const { svc, spies } = mockSupabase();
    const ctx = ctxFor(svc, '');
    await wikiUpdate.execute(
      { id: 'art-1', content: 'new body', message: 'tweak body' },
      ctx
    );
    expect(spies.updateWikiArticle).toHaveBeenCalledTimes(1);
    expect(spies.attachWikiArticleSources).not.toHaveBeenCalled();
  });

  it('rejects when neither title nor content is provided', async () => {
    const { svc } = mockSupabase();
    const ctx = ctxFor(svc, 'thread-abc');
    await expect(
      wikiUpdate.execute({ id: 'art-1', message: 'no-op?' }, ctx)
    ).rejects.toThrow(/at least one of title or content/i);
  });

  it('rejects when message is missing', async () => {
    const { svc } = mockSupabase();
    const ctx = ctxFor(svc, 'thread-abc');
    await expect(
      wikiUpdate.execute({ id: 'art-1', content: 'new body' }, ctx)
    ).rejects.toThrow(/message is required/i);
  });
});

describe('wiki prompts: no inline-citation guidance', () => {
  // The autonomous prompt's twin assertion lives in the Deno suite
  // (supabase/functions/tests/wiki.test.ts) - that prompt moved
  // server-side with its agent.
  it('librarian prompt advertises source_thread_ids instead of inline citations', async () => {
    const { buildWikiLibrarianPrompt } = await import(
      '../src/lib/agents/wiki-librarian/prompt'
    );
    const prompt = buildWikiLibrarianPrompt({
      articleList: '- `foo` - example',
      userProfile: null,
    });
    expect(prompt).not.toContain('?cid=');
    expect(prompt).not.toContain('[label](?cid');
    expect(prompt).toContain('source_thread_ids');
  });
});
