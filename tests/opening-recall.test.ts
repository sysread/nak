/**
 * Opening-turn memory recall — confidence-tag formatting and
 * relation traversal. The function is the entry point that runs on
 * every fresh thread's first message, so its output is what the LLM
 * reads as its own "prior recollection." The tests here verify two
 * load-bearing behaviours of the volitional-memory layer:
 *
 *   1. Retrieved memories get their confidence rendered as an inline
 *      qualitative tag ([corroborated]/[hedged]/[shaky]) so the LLM
 *      reads its own uncertainty without having to reason about
 *      numbers.
 *   2. Outbound relations ride along underneath the matched memory
 *      (1 hop, capped fan-out), so the LLM sees the graph it has
 *      been building rather than a bag of disconnected facts.
 *
 * Higher-level behaviours (Venice embed failure, threshold filter,
 * empty user text) are tested by covering the key branches of the
 * entry point, not by exhausting every combination.
 */
import { describe, it, expect, vi } from 'vitest';
import { recallOpeningMemories } from '../src/lib/opening-recall';
import type { MemoryRelation, SupabaseService } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';

function makeVenice(embedding: number[] = [0.1, 0.2, 0.3]): VeniceClient {
  const embed = vi.fn().mockResolvedValue({
    data: [{ embedding }],
  });
  return { embed } as unknown as VeniceClient;
}

function makeSupabase(
  scoredRows: Array<{
    id: string;
    label: string;
    data: string;
    confidence: number;
    similarity: number;
  }>,
  edges: MemoryRelation[] = []
): SupabaseService {
  return {
    searchMemoriesByEmbeddingScored: vi.fn().mockResolvedValue(scoredRows),
    listMemoryRelationsFor: vi.fn().mockResolvedValue(edges),
  } as unknown as SupabaseService;
}

describe('recallOpeningMemories — confidence tags in output', () => {
  it('prefixes [corroborated] when the matched row has high confidence', async () => {
    const supabase = makeSupabase([
      {
        id: 'm-1',
        label: 'Jeff prefers ASCII',
        data: 'No smart quotes, no em-dashes.',
        confidence: 6.0,
        similarity: 0.7,
      },
    ]);
    const result = await recallOpeningMemories(
      supabase,
      makeVenice(),
      'what does Jeff think about em-dashes'
    );
    expect(result).toContain('[corroborated] Jeff prefers ASCII:');
  });

  it('prefixes [hedged] when confidence is in the [0.5, 1.5) band', async () => {
    const supabase = makeSupabase([
      {
        id: 'm-1',
        label: 'Might like tea',
        data: 'He mentioned it once.',
        confidence: 1.0,
        similarity: 0.55,
      },
    ]);
    const result = await recallOpeningMemories(
      supabase,
      makeVenice(),
      'what does Jeff drink'
    );
    expect(result).toContain('[hedged] Might like tea:');
  });

  it('prefixes [shaky] when confidence is below 0.5', async () => {
    const supabase = makeSupabase([
      {
        id: 'm-1',
        label: 'Was curious about Haskell',
        data: 'Two years ago.',
        confidence: 0.2,
        similarity: 0.45,
      },
    ]);
    const result = await recallOpeningMemories(
      supabase,
      makeVenice(),
      'programming languages Jeff likes'
    );
    expect(result).toContain('[shaky] Was curious about Haskell:');
  });

  it('emits no bracketed tag when confidence is in the neutral band', async () => {
    const supabase = makeSupabase([
      {
        id: 'm-1',
        label: 'Uses pnpm',
        data: 'Consistent across projects.',
        confidence: 2.0,
        similarity: 0.8,
      },
    ]);
    const result = await recallOpeningMemories(
      supabase,
      makeVenice(),
      'what package manager'
    );
    expect(result).not.toMatch(/\[(corroborated|hedged|shaky)\] Uses pnpm/);
    expect(result).toContain('- Uses pnpm:');
  });
});

describe('recallOpeningMemories — outbound relation traversal', () => {
  it('renders outbound edges under their source with kind and target tag', async () => {
    const edges: MemoryRelation[] = [
      {
        id: 'r-1',
        from_memory_id: 'm-1',
        to_memory_id: 'm-2',
        kind: 'supports',
        note: null,
        created_at: '2024-01-01T00:00:00Z',
        to_label: 'Hates smart quotes',
        to_data: 'Linted them out of comments.',
        to_confidence: 6.0,
      },
    ];
    const supabase = makeSupabase(
      [
        {
          id: 'm-1',
          label: 'Prefers ASCII',
          data: 'Plain text over typography.',
          confidence: 4.0,
          similarity: 0.7,
        },
      ],
      edges
    );
    const result = await recallOpeningMemories(
      supabase,
      makeVenice(),
      'what about punctuation'
    );
    expect(result).toContain('- Prefers ASCII:');
    expect(result).toContain(
      '  supports: [corroborated] Hates smart quotes: Linted them out of comments.'
    );
  });

  it('caps per-source fan-out to 5 edges even when the graph has more', async () => {
    const edges: MemoryRelation[] = Array.from({ length: 8 }, (_, i) => ({
      id: `r-${i}`,
      from_memory_id: 'm-1',
      to_memory_id: `m-${i + 2}`,
      kind: 'supports',
      note: null,
      created_at: `2024-01-0${i + 1}T00:00:00Z`,
      to_label: `target-${i}`,
      to_data: `body-${i}`,
      to_confidence: 2.0,
    }));
    const supabase = makeSupabase(
      [
        {
          id: 'm-1',
          label: 'Hub',
          data: 'Well-connected.',
          confidence: 2.0,
          similarity: 0.9,
        },
      ],
      edges
    );
    const result = await recallOpeningMemories(
      supabase,
      makeVenice(),
      'hub query'
    );
    // First 5 targets render, 6th and onward don't.
    expect(result).toContain('target-0');
    expect(result).toContain('target-4');
    expect(result).not.toContain('target-5');
    expect(result).not.toContain('target-7');
  });

  it('returns a block with no relations section when none exist', async () => {
    const supabase = makeSupabase([
      {
        id: 'm-1',
        label: 'Standalone',
        data: 'No edges yet.',
        confidence: 2.0,
        similarity: 0.7,
      },
    ]);
    const result = await recallOpeningMemories(
      supabase,
      makeVenice(),
      'standalone query'
    );
    expect(result).toContain('- Standalone: No edges yet.');
    expect(result).not.toMatch(/\n  (supports|contradicts|generalises|specialises):/);
  });

  it('degrades to no-relations when the edge RPC fails', async () => {
    // Edge-fetch failure must not break the whole recall block -
    // relations are enrichment, not a requirement.
    const listMemoryRelationsFor = vi
      .fn()
      .mockRejectedValue(new Error('rpc down'));
    const svc = {
      searchMemoriesByEmbeddingScored: vi.fn().mockResolvedValue([
        {
          id: 'm-1',
          label: 'Solo',
          data: 'no edges.',
          confidence: 2.0,
          similarity: 0.7,
        },
      ]),
      listMemoryRelationsFor,
    } as unknown as SupabaseService;
    const result = await recallOpeningMemories(
      svc,
      makeVenice(),
      'solo query'
    );
    expect(result).toContain('- Solo:');
    expect(result).not.toMatch(/supports|contradicts|generalises|specialises/);
  });
});

describe('recallOpeningMemories — no-match and empty paths', () => {
  it('returns null for empty user text (no embed call)', async () => {
    const embed = vi.fn();
    const venice = { embed } as unknown as VeniceClient;
    const svc = makeSupabase([]);
    const result = await recallOpeningMemories(svc, venice, '');
    expect(result).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it('returns null when no rows cross the threshold', async () => {
    // Scored RPC returns a row, but its similarity is below the
    // 0.4 OPENING_RECALL_MIN_SCORE gate.
    const svc = makeSupabase([
      {
        id: 'm-1',
        label: 'weak',
        data: 'weak match.',
        confidence: 1.0,
        similarity: 0.2,
      },
    ]);
    const result = await recallOpeningMemories(svc, makeVenice(), 'query');
    expect(result).toBeNull();
  });
});
