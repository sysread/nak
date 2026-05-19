/**
 * Unit coverage for the volitional-memory tool surface:
 *
 *   - memory_create's new optional `confidence` parameter
 *   - memory_reaffirm (+0.5 cap 10.0) routing
 *   - memory_doubt (x0.7 no floor) routing
 *   - memory_relate (edge insert, self-loop rejection, kind validation,
 *     duplicate handling)
 *   - memory_unrelate (edge delete)
 *   - registry scoping: all four live in both `memoriesToolbox` (chat)
 *     and `memoryToolbox` (reflection); none in `recallToolbox`
 *     (read-only).
 *
 * The Supabase layer is stubbed per-test. RLS is a Supabase concern -
 * the tools' job is wiring the right RPC with the right args and
 * surfacing the right shape back to the model.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  memoriesToolbox,
  memoryToolbox,
  recallToolbox,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import { memoryCreate } from '../src/lib/tools/memory_create';
import { memoryReaffirm } from '../src/lib/tools/memory_reaffirm';
import { memoryDoubt } from '../src/lib/tools/memory_doubt';
import { memoryRelate } from '../src/lib/tools/memory_relate';
import { memoryUnrelate } from '../src/lib/tools/memory_unrelate';
import type { Memory, SupabaseService } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';

function sampleMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm-1',
    label: 'Test',
    data: 'Test data',
    confidence: 1.0,
    topics: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function ctxFor(svc: Partial<SupabaseService>): ToolContext {
  return {
    supabase: svc as SupabaseService,
    venice: {} as VeniceClient,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

describe('volitional memory tools — registry scoping', () => {
  it('memoriesToolbox (chat) exposes reaffirm/doubt/relate/unrelate', () => {
    const names = memoriesToolbox.tools.map((t: ToolDef) => t.name);
    expect(names).toContain('memory_reaffirm');
    expect(names).toContain('memory_doubt');
    expect(names).toContain('memory_relate');
    expect(names).toContain('memory_unrelate');
    // And still ships the user-authorised hard-delete.
    expect(names).toContain('memory_delete');
  });

  it('memoryToolbox (reflection) exposes the same four alongside invalidate', () => {
    const names = memoryToolbox.tools.map((t: ToolDef) => t.name);
    expect(names).toContain('memory_reaffirm');
    expect(names).toContain('memory_doubt');
    expect(names).toContain('memory_relate');
    expect(names).toContain('memory_unrelate');
    expect(names).toContain('memory_invalidate');
    // Reflection still does NOT get hard-delete on its own authority.
    expect(names).not.toContain('memory_delete');
  });

  it('recallToolbox (read-only) must not contain any volitional write tools', () => {
    const names = recallToolbox.tools.map((t: ToolDef) => t.name);
    expect(names).not.toContain('memory_reaffirm');
    expect(names).not.toContain('memory_doubt');
    expect(names).not.toContain('memory_relate');
    expect(names).not.toContain('memory_unrelate');
    expect(names).not.toContain('memory_create');
  });
});

describe('memory_create — optional confidence parameter', () => {
  it('defers to the schema default when confidence is omitted', async () => {
    const createMemory = vi.fn().mockResolvedValue(sampleMemory());
    await memoryCreate.execute(
      { label: 'L', data: 'D' },
      ctxFor({ createMemory } as unknown as Partial<SupabaseService>)
    );
    // Third arg is undefined (not passed through as explicit number).
    expect(createMemory).toHaveBeenCalledWith('L', 'D', undefined);
  });

  it('forwards a supplied confidence value to createMemory', async () => {
    const createMemory = vi.fn().mockResolvedValue(sampleMemory({ confidence: 3.0 }));
    await memoryCreate.execute(
      { label: 'L', data: 'D', confidence: 3.0 },
      ctxFor({ createMemory } as unknown as Partial<SupabaseService>)
    );
    expect(createMemory).toHaveBeenCalledWith('L', 'D', 3.0);
  });

  it('rejects out-of-range confidence instead of clamping', async () => {
    const createMemory = vi.fn();
    await expect(
      memoryCreate.execute(
        { label: 'L', data: 'D', confidence: 0.5 },
        ctxFor({ createMemory } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/\[1\.0, 10\.0\]/);
    await expect(
      memoryCreate.execute(
        { label: 'L', data: 'D', confidence: 11.0 },
        ctxFor({ createMemory } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/\[1\.0, 10\.0\]/);
    expect(createMemory).not.toHaveBeenCalled();
  });

  it('rejects non-numeric confidence', async () => {
    const createMemory = vi.fn();
    await expect(
      memoryCreate.execute(
        { label: 'L', data: 'D', confidence: 'high' as unknown as number },
        ctxFor({ createMemory } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/finite number/);
    expect(createMemory).not.toHaveBeenCalled();
  });
});

describe('memory_reaffirm', () => {
  it('routes through reaffirmMemoryConfidence and echoes the post-bump value', async () => {
    const reaffirmMemoryConfidence = vi.fn().mockResolvedValue(1.5);
    const result = await memoryReaffirm.execute(
      { id: 'm-1' },
      ctxFor({ reaffirmMemoryConfidence } as unknown as Partial<SupabaseService>)
    );
    expect(reaffirmMemoryConfidence).toHaveBeenCalledWith('m-1');
    expect(result).toEqual({ id: 'm-1', confidence: 1.5 });
  });

  it('throws when the RPC returns null (row missing or RLS-blocked)', async () => {
    const reaffirmMemoryConfidence = vi.fn().mockResolvedValue(null);
    await expect(
      memoryReaffirm.execute(
        { id: 'bogus' },
        ctxFor({ reaffirmMemoryConfidence } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/not found/);
  });

  it('requires id', async () => {
    await expect(
      memoryReaffirm.execute(
        {},
        ctxFor({ reaffirmMemoryConfidence: vi.fn() } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/id is required/);
  });
});

describe('memory_doubt', () => {
  it('routes through doubtMemoryConfidence and echoes the post-decay value', async () => {
    const doubtMemoryConfidence = vi.fn().mockResolvedValue(0.7);
    const result = await memoryDoubt.execute(
      { id: 'm-1' },
      ctxFor({ doubtMemoryConfidence } as unknown as Partial<SupabaseService>)
    );
    expect(doubtMemoryConfidence).toHaveBeenCalledWith('m-1');
    expect(result).toEqual({ id: 'm-1', confidence: 0.7 });
  });

  it('throws on null (row missing or RLS-blocked)', async () => {
    const doubtMemoryConfidence = vi.fn().mockResolvedValue(null);
    await expect(
      memoryDoubt.execute(
        { id: 'bogus' },
        ctxFor({ doubtMemoryConfidence } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/not found/);
  });
});

describe('memory_relate', () => {
  it('inserts via createMemoryRelation with trimmed note', async () => {
    const createMemoryRelation = vi
      .fn()
      .mockResolvedValue({ id: 'r-1', kind: 'supports' });
    const result = await memoryRelate.execute(
      {
        from_id: 'm-1',
        to_id: 'm-2',
        kind: 'supports',
        note: '  same pattern, different angle  ',
      },
      ctxFor({ createMemoryRelation } as unknown as Partial<SupabaseService>)
    );
    expect(createMemoryRelation).toHaveBeenCalledWith(
      'm-1',
      'm-2',
      'supports',
      'same pattern, different angle'
    );
    expect(result).toEqual({ id: 'r-1', kind: 'supports' });
  });

  it('passes null note when omitted', async () => {
    const createMemoryRelation = vi
      .fn()
      .mockResolvedValue({ id: 'r-1', kind: 'generalises' });
    await memoryRelate.execute(
      { from_id: 'm-1', to_id: 'm-2', kind: 'generalises' },
      ctxFor({ createMemoryRelation } as unknown as Partial<SupabaseService>)
    );
    expect(createMemoryRelation).toHaveBeenCalledWith(
      'm-1',
      'm-2',
      'generalises',
      null
    );
  });

  it('rejects self-loops at the tool boundary', async () => {
    const createMemoryRelation = vi.fn();
    await expect(
      memoryRelate.execute(
        { from_id: 'm-1', to_id: 'm-1', kind: 'supports' },
        ctxFor({ createMemoryRelation } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/self-loop/);
    expect(createMemoryRelation).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind', async () => {
    const createMemoryRelation = vi.fn();
    await expect(
      memoryRelate.execute(
        { from_id: 'm-1', to_id: 'm-2', kind: 'reinforces' },
        ctxFor({ createMemoryRelation } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(
      /supports, contradicts, generalises, specialises/
    );
    expect(createMemoryRelation).not.toHaveBeenCalled();
  });

  it('collapses duplicate-edge errors to already_exists success', async () => {
    const createMemoryRelation = vi
      .fn()
      .mockRejectedValue(
        new Error('duplicate key value violates unique constraint')
      );
    const result = await memoryRelate.execute(
      { from_id: 'm-1', to_id: 'm-2', kind: 'supports' },
      ctxFor({ createMemoryRelation } as unknown as Partial<SupabaseService>)
    );
    expect(result).toEqual({
      ok: true,
      already_exists: true,
      kind: 'supports',
    });
  });

  it('propagates other errors', async () => {
    const createMemoryRelation = vi
      .fn()
      .mockRejectedValue(new Error('network down'));
    await expect(
      memoryRelate.execute(
        { from_id: 'm-1', to_id: 'm-2', kind: 'supports' },
        ctxFor({ createMemoryRelation } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/network down/);
  });

  it('rejects note over the 500-char limit', async () => {
    const createMemoryRelation = vi.fn();
    await expect(
      memoryRelate.execute(
        {
          from_id: 'm-1',
          to_id: 'm-2',
          kind: 'supports',
          note: 'x'.repeat(501),
        },
        ctxFor({ createMemoryRelation } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/500-char limit/);
  });
});

describe('memory_unrelate', () => {
  it('routes through deleteMemoryRelation with the given id', async () => {
    const deleteMemoryRelation = vi.fn().mockResolvedValue(undefined);
    const result = await memoryUnrelate.execute(
      { id: 'r-1' },
      ctxFor({ deleteMemoryRelation } as unknown as Partial<SupabaseService>)
    );
    expect(deleteMemoryRelation).toHaveBeenCalledWith('r-1');
    expect(result).toEqual({ deleted: true });
  });

  it('requires id', async () => {
    await expect(
      memoryUnrelate.execute(
        {},
        ctxFor({ deleteMemoryRelation: vi.fn() } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/id is required/);
  });
});
