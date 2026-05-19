/**
 * Coverage for the topic-filter path through `searchMemoriesSemantic`.
 *
 * Two integration-shaped behaviours we want to pin:
 *
 *   1. Server-side filter plumbing: the selectedTopics array is
 *      threaded through to both `searchMemories` (ILIKE / list-all
 *      path) and `searchUnembeddedMemoriesByText` (just-written rows).
 *      The wire shape of the filter itself is owned by
 *      `topicsFilterClause` and tested by the threads-search suite -
 *      we don't re-test it here, only the threading.
 *
 *   2. Client-side filter over vector hits: `search_memories_by_embedding`
 *      returns `topics` on each row so semantic results can be
 *      filtered without a second round trip. Untagged rows match
 *      only when the (untagged) sentinel is selected; rows with real
 *      topics match when at least one of their topics is in the
 *      selection (OR semantics, matching the dropdown's contract).
 */
import { describe, it, expect, vi } from 'vitest';
import { searchMemoriesSemantic } from '../src/lib/memories';
import type { Memory, SupabaseService } from '../src/lib/supabase';
import { UNTAGGED_TOPIC_SENTINEL } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';

function row(id: string, topics: string[]): Memory {
  return {
    id,
    label: id,
    data: id,
    confidence: 1,
    topics,
    created_at: 't',
    updated_at: 't',
  };
}

function mockSupabase(overrides: {
  vectorHits?: Memory[];
  ilikeHits?: Memory[];
}) {
  const searchMemories = vi.fn(async () => [] as Memory[]);
  const searchMemoriesByEmbedding = vi.fn(
    async () => overrides.vectorHits ?? []
  );
  const searchUnembeddedMemoriesByText = vi.fn(
    async () => overrides.ilikeHits ?? []
  );
  const svc = {
    searchMemories,
    searchMemoriesByEmbedding,
    searchUnembeddedMemoriesByText,
  } as unknown as SupabaseService;
  return {
    svc,
    spies: {
      searchMemories,
      searchMemoriesByEmbedding,
      searchUnembeddedMemoriesByText,
    },
  };
}

function mockVenice(): VeniceClient {
  return {
    embed: vi.fn(async () => ({
      data: [{ embedding: new Array(1024).fill(0.1) }],
    })),
  } as unknown as VeniceClient;
}

describe('searchMemoriesSemantic topic filter', () => {
  it('forwards selectedTopics to searchMemories on the empty-query path', async () => {
    const { svc, spies } = mockSupabase({});
    await searchMemoriesSemantic('', 20, {
      supabase: svc,
      venice: null,
      selectedTopics: ['food'],
    });
    expect(spies.searchMemories).toHaveBeenCalledWith('', 20, ['food']);
  });

  it('forwards selectedTopics to searchMemories on the no-venice path', async () => {
    const { svc, spies } = mockSupabase({});
    await searchMemoriesSemantic('hi', 20, {
      supabase: svc,
      venice: null,
      selectedTopics: ['food', UNTAGGED_TOPIC_SENTINEL],
    });
    expect(spies.searchMemories).toHaveBeenCalledWith('hi', 20, [
      'food',
      UNTAGGED_TOPIC_SENTINEL,
    ]);
  });

  it('forwards selectedTopics to the unembedded ILIKE probe', async () => {
    const { svc, spies } = mockSupabase({ vectorHits: [], ilikeHits: [] });
    await searchMemoriesSemantic('q', 20, {
      supabase: svc,
      venice: mockVenice(),
      selectedTopics: ['food'],
    });
    expect(spies.searchUnembeddedMemoriesByText).toHaveBeenCalledWith(
      'q',
      20,
      ['food']
    );
  });

  it('client-side-filters semantic hits by real topics (OR semantics)', async () => {
    const { svc } = mockSupabase({
      vectorHits: [
        row('m1', ['food']), // matches
        row('m2', ['travel']), // does not
        row('m3', ['food', 'allergies']), // matches (overlap)
      ],
    });
    const out = await searchMemoriesSemantic('q', 20, {
      supabase: svc,
      venice: mockVenice(),
      selectedTopics: ['food'],
    });
    expect(out.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('client-side-filters semantic hits by the (untagged) sentinel', async () => {
    const { svc } = mockSupabase({
      vectorHits: [
        row('m1', []), // untagged - matches
        row('m2', ['food']), // does not (sentinel only)
        row('m3', []), // matches
      ],
    });
    const out = await searchMemoriesSemantic('q', 20, {
      supabase: svc,
      venice: mockVenice(),
      selectedTopics: [UNTAGGED_TOPIC_SENTINEL],
    });
    expect(out.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('client-side OR: untagged sentinel + a real topic both pass through', async () => {
    const { svc } = mockSupabase({
      vectorHits: [
        row('m1', []), // matches via sentinel
        row('m2', ['food']), // matches via real
        row('m3', ['travel']), // does not match either
      ],
    });
    const out = await searchMemoriesSemantic('q', 20, {
      supabase: svc,
      venice: mockVenice(),
      selectedTopics: [UNTAGGED_TOPIC_SENTINEL, 'food'],
    });
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('no filter = no client-side narrowing of semantic hits', async () => {
    const { svc } = mockSupabase({
      vectorHits: [row('m1', []), row('m2', ['travel'])],
    });
    const out = await searchMemoriesSemantic('q', 20, {
      supabase: svc,
      venice: mockVenice(),
    });
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});
