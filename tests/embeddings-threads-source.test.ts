/**
 * Unit coverage for the threads EmbeddingSource adapter. Mirrors the
 * memories-source test file in shape — the adapter is thin, the
 * interesting logic is in `buildThreadEmbedInput`: title-only vs.
 * title+summary, the truncation boundary, and the claim/save
 * delegation contract.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createThreadsSource,
  buildThreadEmbedInput,
  MAX_THREAD_EMBED_INPUT_CHARS,
} from '../src/lib/embeddings/sources/threads';
import type { SupabaseService } from '../src/lib/supabase';

function mockSupabase() {
  const spies = {
    claimNextPendingThreadForEmbedding: vi.fn(
      async (_holder: string, _ttl: number) =>
        null as { id: string; title: string; summary: string | null } | null
    ),
    saveThreadEmbedding: vi.fn(async () => true),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

describe('buildThreadEmbedInput', () => {
  it('returns just the title when summary is null — summary worker hasn\'t caught up yet', () => {
    expect(buildThreadEmbedInput('Debugging mobile scroll', null)).toBe(
      'Debugging mobile scroll'
    );
  });

  it('joins title and summary with a double-newline boundary', () => {
    const out = buildThreadEmbedInput(
      'Debugging mobile scroll',
      'A thread about a Safari race condition in the chat scroller.'
    );
    expect(out).toBe(
      'Debugging mobile scroll\n\nA thread about a Safari race condition in the chat scroller.'
    );
  });

  it('truncates at MAX_THREAD_EMBED_INPUT_CHARS when combined length overshoots', () => {
    const big = 'x'.repeat(MAX_THREAD_EMBED_INPUT_CHARS + 500);
    const out = buildThreadEmbedInput('title', big);
    expect(out.length).toBe(MAX_THREAD_EMBED_INPUT_CHARS);
    expect(out.startsWith('title\n\n')).toBe(true);
  });

  it('leaves input unchanged when exactly at the cap (no off-by-one truncation)', () => {
    const exactBody = 'y'.repeat(MAX_THREAD_EMBED_INPUT_CHARS - 't\n\n'.length);
    const out = buildThreadEmbedInput('t', exactBody);
    expect(out.length).toBe(MAX_THREAD_EMBED_INPUT_CHARS);
    expect(out).toBe(`t\n\n${exactBody}`);
  });

  it('collapses an empty-string summary to title-only (falsy check, same as null)', () => {
    // The worker's empty-summary branch skips the save, so in
    // practice the adapter sees null (not '') for "no summary". But
    // if an empty string ever lands — defensive — we want the input
    // to still be a valid non-empty string for Venice rather than
    // `t\n\n`, which would be pointless whitespace the model has to
    // tokenize.
    expect(buildThreadEmbedInput('t', '')).toBe('t');
  });
});

describe('createThreadsSource', () => {
  it('has the expected source name — used by the worker\'s progress events', () => {
    const { svc } = mockSupabase();
    expect(createThreadsSource(svc).name).toBe('threads');
  });

  it('forwards holder + TTL and returns null when no thread is pending', async () => {
    const { svc, spies } = mockSupabase();
    const source = createThreadsSource(svc);
    spies.claimNextPendingThreadForEmbedding.mockResolvedValueOnce(null);
    const out = await source.claimNext('holder-1', 180);
    expect(spies.claimNextPendingThreadForEmbedding).toHaveBeenCalledWith('holder-1', 180);
    expect(out).toBeNull();
  });

  it('shapes a claimed row into a PendingItem whose input is title+summary', async () => {
    const { svc, spies } = mockSupabase();
    const source = createThreadsSource(svc);
    spies.claimNextPendingThreadForEmbedding.mockResolvedValueOnce({
      id: 't-1',
      title: 'Refactor supabase wrapper',
      summary: 'A thread about reorganising SupabaseService into smaller chunks.',
    });
    const out = await source.claimNext('h', 180);
    expect(out).toEqual({
      id: 't-1',
      input:
        'Refactor supabase wrapper\n\nA thread about reorganising SupabaseService into smaller chunks.',
    });
  });

  it('falls back to title-only when the summary worker hasn\'t run yet', async () => {
    const { svc, spies } = mockSupabase();
    const source = createThreadsSource(svc);
    spies.claimNextPendingThreadForEmbedding.mockResolvedValueOnce({
      id: 't-2',
      title: 'Fresh conversation',
      summary: null,
    });
    const out = await source.claimNext('h', 180);
    expect(out).toEqual({ id: 't-2', input: 'Fresh conversation' });
  });

  describe('save', () => {
    it('forwards all four args and returns the RPC result', async () => {
      const { svc, spies } = mockSupabase();
      const source = createThreadsSource(svc);
      const embedding = [0.1, 0.2, 0.3];
      spies.saveThreadEmbedding.mockResolvedValueOnce(true);
      const ok = await source.save('t-1', 'h', embedding, 'bge-m3');
      expect(ok).toBe(true);
      expect(spies.saveThreadEmbedding).toHaveBeenCalledWith('t-1', 'h', embedding, 'bge-m3');
    });

    it('propagates false when the concurrency guard rejected the write', async () => {
      const { svc, spies } = mockSupabase();
      const source = createThreadsSource(svc);
      spies.saveThreadEmbedding.mockResolvedValueOnce(false);
      expect(await source.save('t-1', 'h', [0], 'm')).toBe(false);
    });
  });
});
