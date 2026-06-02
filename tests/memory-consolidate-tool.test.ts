/**
 * Unit coverage for the memory_consolidate tool and the
 * memoryLibrarianToolbox composition.
 *
 *   - tool surface validation (required fields, length cap on data,
 *     self-merge rejection)
 *   - argument trimming + happy-path RPC dispatch
 *   - toolbox scoping: present in memoryLibrarianToolbox; absent from
 *     memoriesToolbox, memoryToolbox, recallToolbox
 *   - toolbox composition: librarian set excludes memory_create and
 *     memory_update (the design rules from the librarian discussion)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  memoriesToolbox,
  memoryToolbox,
  recallToolbox,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import { memoryLibrarianToolbox } from '../src/lib/tools/memory_librarian_toolbox';
import { memoryConsolidate } from '../src/lib/tools/memory_consolidate';
import { MAX_MEMORY_DATA_CHARS } from '../src/lib/memories';
import type { SupabaseService } from '../src/lib/supabase';

function ctxFor(svc: Partial<SupabaseService>): ToolContext {
  return {
    supabase: svc as SupabaseService,
    userId: 'u-1',
    threadId: '',
    signal: new AbortController().signal,
  };
}

describe('memoryLibrarianToolbox composition', () => {
  it('exposes memory_consolidate', () => {
    const names = memoryLibrarianToolbox.tools.map((t: ToolDef) => t.name);
    expect(names).toContain('memory_consolidate');
  });

  it('includes graph-management and soft-delete primitives', () => {
    const names = memoryLibrarianToolbox.tools.map((t: ToolDef) => t.name);
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_invalidate');
    expect(names).toContain('memory_doubt');
    expect(names).toContain('memory_relate');
    expect(names).toContain('memory_unrelate');
    expect(names).toContain('conversation_search');
  });

  it('omits create / update / reaffirm (librarian collapses, never invents or auto-bumps)', () => {
    const names = memoryLibrarianToolbox.tools.map((t: ToolDef) => t.name);
    expect(names).not.toContain('memory_create');
    expect(names).not.toContain('memory_update');
    expect(names).not.toContain('memory_reaffirm');
    expect(names).not.toContain('memory_recall');
    expect(names).not.toContain('memory_delete');
  });

  it('memory_consolidate is NOT in the chat / reflection / recall toolboxes', () => {
    expect(memoriesToolbox.tools.map((t: ToolDef) => t.name)).not.toContain(
      'memory_consolidate'
    );
    expect(memoryToolbox.tools.map((t: ToolDef) => t.name)).not.toContain(
      'memory_consolidate'
    );
    expect(recallToolbox.tools.map((t: ToolDef) => t.name)).not.toContain(
      'memory_consolidate'
    );
  });
});

describe('memory_consolidate tool', () => {
  it('rejects missing survivor_id', async () => {
    await expect(
      memoryConsolidate.execute(
        { survivor_id: '', loser_id: 'b', label: 'L', data: 'd', activity: 'x' },
        ctxFor({})
      )
    ).rejects.toThrow(/survivor_id/);
  });

  it('rejects missing loser_id', async () => {
    await expect(
      memoryConsolidate.execute(
        { survivor_id: 'a', loser_id: '', label: 'L', data: 'd', activity: 'x' },
        ctxFor({})
      )
    ).rejects.toThrow(/loser_id/);
  });

  it('rejects self-merge', async () => {
    await expect(
      memoryConsolidate.execute(
        { survivor_id: 'a', loser_id: 'a', label: 'L', data: 'd', activity: 'x' },
        ctxFor({})
      )
    ).rejects.toThrow(/must differ/);
  });

  it('rejects empty label', async () => {
    await expect(
      memoryConsolidate.execute(
        { survivor_id: 'a', loser_id: 'b', label: '   ', data: 'd', activity: 'x' },
        ctxFor({})
      )
    ).rejects.toThrow(/label/);
  });

  it('rejects empty data', async () => {
    await expect(
      memoryConsolidate.execute(
        { survivor_id: 'a', loser_id: 'b', label: 'L', data: '', activity: 'x' },
        ctxFor({})
      )
    ).rejects.toThrow(/data/);
  });

  it('rejects oversize data', async () => {
    const oversize = 'x'.repeat(MAX_MEMORY_DATA_CHARS + 1);
    await expect(
      memoryConsolidate.execute(
        {
          survivor_id: 'a',
          loser_id: 'b',
          label: 'L',
          data: oversize,
          activity: 'x',
        },
        ctxFor({})
      )
    ).rejects.toThrow(/exceeds/);
  });

  it('dispatches the consolidate RPC with the trimmed survivor body', async () => {
    const consolidateMemories = vi.fn(async () => 2.5);
    const result = await memoryConsolidate.execute(
      {
        survivor_id: '  a-id ',
        loser_id: 'b-id ',
        label: '  Merged label  ',
        data: 'merged body',
        activity: 'consolidating',
      },
      ctxFor({ consolidateMemories: consolidateMemories as unknown as SupabaseService['consolidateMemories'] })
    );
    expect(consolidateMemories).toHaveBeenCalledWith(
      'a-id',
      'b-id',
      'Merged label',
      'merged body'
    );
    expect(result).toEqual({ survivor_id: 'a-id', confidence: 2.5 });
  });

  it('propagates server-side errors verbatim', async () => {
    const consolidateMemories = vi.fn(async () => {
      throw new Error('survivor memory not found');
    });
    await expect(
      memoryConsolidate.execute(
        {
          survivor_id: 'a',
          loser_id: 'b',
          label: 'L',
          data: 'd',
          activity: 'x',
        },
        ctxFor({ consolidateMemories: consolidateMemories as unknown as SupabaseService['consolidateMemories'] })
      )
    ).rejects.toThrow(/survivor memory not found/);
  });
});
