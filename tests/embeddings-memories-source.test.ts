/**
 * Unit coverage for the memories EmbeddingSource adapter. The adapter
 * is thin (delegates to SupabaseService RPCs) but the input-building
 * logic — label prefix, data truncation, boundary behaviour — is where
 * silent bugs would land, so most of the assertions live there.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createMemoriesSource,
  buildMemoryEmbedInput,
} from '../src/lib/embeddings/sources/memories';
import { MAX_MEMORY_DATA_CHARS } from '../src/lib/embeddings/types';
import type { SupabaseService } from '../src/lib/supabase';

function mockSupabase() {
  const spies = {
    claimNextPendingMemory: vi.fn(
      async (_holder: string, _ttl: number) =>
        null as { id: string; label: string; data: string } | null
    ),
    saveMemoryEmbedding: vi.fn(async () => true),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

describe('buildMemoryEmbedInput', () => {
  it('joins label and data with a double-newline boundary', () => {
    expect(buildMemoryEmbedInput('gym PIN', '12345')).toBe('gym PIN\n\n12345');
  });

  it('preserves the label regardless of data length', () => {
    const longData = 'x'.repeat(MAX_MEMORY_DATA_CHARS * 2);
    const out = buildMemoryEmbedInput('label', longData);
    // The label prefix is always there — truncation doesn't eat into it.
    expect(out.startsWith('label\n\n')).toBe(true);
  });

  it('truncates data at MAX_MEMORY_DATA_CHARS — not the concatenated length', () => {
    const longData = 'x'.repeat(MAX_MEMORY_DATA_CHARS + 500);
    const out = buildMemoryEmbedInput('label', longData);
    // label + \n\n + truncated-data; truncated portion is exactly MAX.
    const body = out.slice('label\n\n'.length);
    expect(body.length).toBe(MAX_MEMORY_DATA_CHARS);
    expect(body).toBe('x'.repeat(MAX_MEMORY_DATA_CHARS));
  });

  it('leaves data unchanged when exactly at the cap (no off-by-one truncation)', () => {
    const exactData = 'y'.repeat(MAX_MEMORY_DATA_CHARS);
    const out = buildMemoryEmbedInput('label', exactData);
    expect(out).toBe(`label\n\n${exactData}`);
  });

  it('leaves data unchanged when under the cap', () => {
    expect(buildMemoryEmbedInput('a', 'b')).toBe('a\n\nb');
  });
});

describe('createMemoriesSource', () => {
  it('has the expected source name (logged + reported in progress events)', () => {
    const { svc } = mockSupabase();
    expect(createMemoriesSource(svc).name).toBe('memories');
  });

  describe('claimNext', () => {
    it('forwards holder + TTL to the RPC and returns null when nothing is pending', async () => {
      const { svc, spies } = mockSupabase();
      const source = createMemoriesSource(svc);
      spies.claimNextPendingMemory.mockResolvedValueOnce(null);
      const out = await source.claimNext('holder-1', 120);
      expect(spies.claimNextPendingMemory).toHaveBeenCalledWith('holder-1', 120);
      expect(out).toBeNull();
    });

    it('shapes a claimed row into a PendingItem with label+data as input', async () => {
      const { svc, spies } = mockSupabase();
      const source = createMemoriesSource(svc);
      spies.claimNextPendingMemory.mockResolvedValueOnce({
        id: 'm-1',
        label: 'gym PIN',
        data: '12345',
      });
      const out = await source.claimNext('h', 120);
      expect(out).toEqual({ id: 'm-1', input: 'gym PIN\n\n12345' });
    });

    it('truncates oversized historical rows to MAX_MEMORY_DATA_CHARS before embedding', async () => {
      const { svc, spies } = mockSupabase();
      const source = createMemoriesSource(svc);
      spies.claimNextPendingMemory.mockResolvedValueOnce({
        id: 'm-1',
        label: 'big',
        data: 'z'.repeat(MAX_MEMORY_DATA_CHARS + 1000),
      });
      const out = await source.claimNext('h', 120);
      // The label + delimiter + exactly-MAX characters of body.
      expect(out!.input.length).toBe('big\n\n'.length + MAX_MEMORY_DATA_CHARS);
    });
  });

  describe('save', () => {
    it('forwards all four args unchanged and returns the RPC result', async () => {
      const { svc, spies } = mockSupabase();
      const source = createMemoriesSource(svc);
      const embedding = [1, 2, 3];
      spies.saveMemoryEmbedding.mockResolvedValueOnce(true);
      const ok = await source.save('m-1', 'h', embedding, 'bge-m3');
      expect(ok).toBe(true);
      expect(spies.saveMemoryEmbedding).toHaveBeenCalledWith('m-1', 'h', embedding, 'bge-m3');
    });

    it('propagates false when the concurrency guard rejected the write', async () => {
      const { svc, spies } = mockSupabase();
      const source = createMemoriesSource(svc);
      spies.saveMemoryEmbedding.mockResolvedValueOnce(false);
      expect(await source.save('m-1', 'h', [0], 'm')).toBe(false);
    });
  });
});
