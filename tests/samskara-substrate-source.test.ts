/**
 * Coverage for the samskara-substrate EmbeddingSource adapter. Same
 * shape as embeddings-memories-source.test.ts: assert the input
 * composition (the Venice-bound string) and the claim/save delegation
 * to SupabaseService stay correct.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildSubstrateEmbedInput,
  createSamskaraSubstrateSource,
} from '../src/lib/embeddings/sources/samskara-substrate';
import type { SupabaseService } from '../src/lib/supabase';

describe('buildSubstrateEmbedInput', () => {
  it('returns the situation alone when outcome is missing', () => {
    expect(buildSubstrateEmbedInput('situation only', null)).toBe('situation only');
    expect(buildSubstrateEmbedInput('situation only', '')).toBe('situation only');
  });

  it('joins situation and outcome with a double newline', () => {
    expect(buildSubstrateEmbedInput('sit', 'out')).toBe('sit\n\nout');
  });

  it('truncates the situation past 6000 chars', () => {
    const long = 'a'.repeat(7000);
    const out = buildSubstrateEmbedInput(long, null);
    expect(out.length).toBe(6000);
  });

  it('truncates the outcome past 2000 chars but keeps the situation intact', () => {
    const longOut = 'b'.repeat(3000);
    const out = buildSubstrateEmbedInput('hi', longOut);
    expect(out.startsWith('hi\n\n')).toBe(true);
    expect(out.length).toBe(2 + 2 + 2000);
  });
});

describe('createSamskaraSubstrateSource', () => {
  function fakeSupabase() {
    return {
      samskaraClaimNextSubstrateEmbed: vi.fn(),
      samskaraSaveSubstrateEmbedding: vi.fn(),
    } as unknown as SupabaseService;
  }

  it('claimNext returns null when the RPC has nothing pending', async () => {
    const sb = fakeSupabase();
    (
      sb as unknown as {
        samskaraClaimNextSubstrateEmbed: ReturnType<typeof vi.fn>;
      }
    ).samskaraClaimNextSubstrateEmbed.mockResolvedValueOnce(null);
    const src = createSamskaraSubstrateSource(sb);
    expect(await src.claimNext('h', 60)).toBeNull();
  });

  it('claimNext shapes the input string from the row', async () => {
    const sb = fakeSupabase();
    (
      sb as unknown as {
        samskaraClaimNextSubstrateEmbed: ReturnType<typeof vi.fn>;
      }
    ).samskaraClaimNextSubstrateEmbed.mockResolvedValueOnce({
      id: 'sub-1',
      situation: 'user asked X',
      outcome: 'assistant did Y',
    });
    const src = createSamskaraSubstrateSource(sb);
    const item = await src.claimNext('h', 60);
    expect(item).toEqual({ id: 'sub-1', input: 'user asked X\n\nassistant did Y' });
  });

  it('save delegates to the supabase RPC verbatim', async () => {
    const sb = fakeSupabase();
    (
      sb as unknown as { samskaraSaveSubstrateEmbedding: ReturnType<typeof vi.fn> }
    ).samskaraSaveSubstrateEmbedding.mockResolvedValueOnce(true);
    const src = createSamskaraSubstrateSource(sb);
    const ok = await src.save('sub-1', 'h', [0.1, 0.2], 'bge-m3');
    expect(ok).toBe(true);
    expect(
      (sb as unknown as { samskaraSaveSubstrateEmbedding: ReturnType<typeof vi.fn> })
        .samskaraSaveSubstrateEmbedding
    ).toHaveBeenCalledWith('sub-1', 'h', [0.1, 0.2], 'bge-m3');
  });
});
