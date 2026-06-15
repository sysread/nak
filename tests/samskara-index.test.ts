/**
 * Coverage for the samskara chat-loop surface (src/lib/samskara/index.ts).
 *
 * These three functions are the ONLY synchronous samskara reads/writes
 * the chat loop performs, and their load-bearing contract is the
 * error-swallow: a samskara failure must never block a user's chat turn
 * (see chat.md and the index.ts preamble). supabase-js re-throws the
 * raw fetch TypeError ("Failed to fetch") on a network blip rather than
 * returning it in the { error } envelope, so without the swallow a
 * transient offline moment would paint an error banner at turn-start.
 * That swallow is exactly what this suite pins.
 *
 * Drives the real functions against a mock SupabaseService, the same
 * shape samskara-browse-store.test.ts uses. padEmbeddingForStorage and
 * topKForCorpusSize run for real - cheap pure helpers with their own
 * coverage.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getCompoundSummary,
  fireSamskaras,
  recordSubstrateStub,
} from '../src/lib/samskara/index';
import { STALE_CEILING_HOURS, FIRE_SCORE_FLOOR } from '../src/lib/samskara/types';
import type { SupabaseService } from '../src/lib/supabase';

type CompoundRow = {
  summary: string | null;
  lastRegenAt: string | null;
  samskaraCountAtRegen: number;
};

type FireRow = {
  id: string;
  prediction: string;
  inner_voice: string | null;
  valence: number;
  confidence: number;
  health: number;
  score: number;
};

function fireRow(id: string, score: number): FireRow {
  return {
    id,
    prediction: `pred ${id}`,
    inner_voice: null,
    valence: 0,
    confidence: 0.5,
    health: 1,
    score,
  };
}

function fakeSupabase(overrides: Partial<SupabaseService> = {}): SupabaseService {
  return {
    samskaraGetCompoundSummary: vi.fn(async (): Promise<CompoundRow | null> => null),
    embed: vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] as number[] }] })),
    samskaraFireTopK: vi.fn(async (): Promise<FireRow[]> => []),
    samskaraRecordFires: vi.fn(async () => undefined),
    samskaraRecordSubstrate: vi.fn(async () => 'substrate-id'),
    ...overrides,
  } as unknown as SupabaseService;
}

// A lastRegenAt within the staleness ceiling, and one past it. Computed
// off Date.now() so the test tracks the constant rather than a literal.
function freshRegenIso(): string {
  return new Date(Date.now() - 60 * 1000).toISOString();
}
function staleRegenIso(): string {
  return new Date(Date.now() - (STALE_CEILING_HOURS + 1) * 60 * 60 * 1000).toISOString();
}

describe('getCompoundSummary', () => {
  it('returns the summary string for a fresh row', async () => {
    const sb = fakeSupabase({
      samskaraGetCompoundSummary: vi.fn(async () => ({
        summary: 'the user tends to X',
        lastRegenAt: freshRegenIso(),
        samskaraCountAtRegen: 4,
      })),
    } as unknown as Partial<SupabaseService>);
    expect(await getCompoundSummary(sb)).toBe('the user tends to X');
  });

  it('returns the summary when lastRegenAt is null (no ceiling to apply)', async () => {
    const sb = fakeSupabase({
      samskaraGetCompoundSummary: vi.fn(async () => ({
        summary: 'always-on bias',
        lastRegenAt: null,
        samskaraCountAtRegen: 0,
      })),
    } as unknown as Partial<SupabaseService>);
    expect(await getCompoundSummary(sb)).toBe('always-on bias');
  });

  it('returns null on cold start (absent row)', async () => {
    const sb = fakeSupabase({
      samskaraGetCompoundSummary: vi.fn(async () => null),
    } as unknown as Partial<SupabaseService>);
    expect(await getCompoundSummary(sb)).toBeNull();
  });

  it('returns null when the summary is an empty string', async () => {
    const sb = fakeSupabase({
      samskaraGetCompoundSummary: vi.fn(async () => ({
        summary: '',
        lastRegenAt: freshRegenIso(),
        samskaraCountAtRegen: 0,
      })),
    } as unknown as Partial<SupabaseService>);
    expect(await getCompoundSummary(sb)).toBeNull();
  });

  it('returns null when the cache is older than the staleness ceiling', async () => {
    const sb = fakeSupabase({
      samskaraGetCompoundSummary: vi.fn(async () => ({
        summary: 'a stale read we would rather not inject',
        lastRegenAt: staleRegenIso(),
        samskaraCountAtRegen: 9,
      })),
    } as unknown as Partial<SupabaseService>);
    expect(await getCompoundSummary(sb)).toBeNull();
  });

  it('swallows a thrown read and returns null (network blip never blocks the turn)', async () => {
    const sb = fakeSupabase({
      samskaraGetCompoundSummary: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    } as unknown as Partial<SupabaseService>);
    await expect(getCompoundSummary(sb)).resolves.toBeNull();
  });
});

describe('fireSamskaras', () => {
  it('skips empty/whitespace user text without embedding', async () => {
    const embed = vi.fn(async () => ({ data: [{ embedding: [0.1] as number[] }] }));
    const sb = fakeSupabase({ embed } as unknown as Partial<SupabaseService>);
    expect(await fireSamskaras(sb, 'thread', 1, '   ')).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it('returns a cohort of above-floor fires and records them', async () => {
    const recordFires = vi.fn(async () => undefined);
    const sb = fakeSupabase({
      samskaraFireTopK: vi.fn(async () => [fireRow('a', 0.9), fireRow('b', 0.4)]),
      samskaraRecordFires: recordFires,
    } as unknown as Partial<SupabaseService>);

    const result = await fireSamskaras(sb, 'thread-1', 3, 'hello there');
    expect(result).not.toBeNull();
    expect(result?.fired.map((f) => f.id)).toEqual(['a', 'b']);
    expect(typeof result?.cohortId).toBe('string');
    expect(result?.cohortId.length).toBeGreaterThan(0);

    // The cohort id and user round ride into the fire log unchanged.
    expect(recordFires).toHaveBeenCalledWith(
      result?.cohortId,
      'thread-1',
      3,
      [
        { samskaraId: 'a', score: 0.9 },
        { samskaraId: 'b', score: 0.4 },
      ]
    );
  });

  it('drops rows below FIRE_SCORE_FLOOR before forming the cohort', async () => {
    const recordFires = vi.fn(async () => undefined);
    const sb = fakeSupabase({
      samskaraFireTopK: vi.fn(async () => [
        fireRow('live', FIRE_SCORE_FLOOR + 0.01),
        fireRow('dead', FIRE_SCORE_FLOOR - 0.001),
      ]),
      samskaraRecordFires: recordFires,
    } as unknown as Partial<SupabaseService>);

    const result = await fireSamskaras(sb, 'thread', 1, 'text');
    expect(result?.fired.map((f) => f.id)).toEqual(['live']);
    // Only the above-floor row reaches the fire log.
    expect(recordFires).toHaveBeenCalledWith(result?.cohortId, 'thread', 1, [
      { samskaraId: 'live', score: FIRE_SCORE_FLOOR + 0.01 },
    ]);
  });

  it('returns null when every row is below the score floor (dormant corpus)', async () => {
    const sb = fakeSupabase({
      samskaraFireTopK: vi.fn(async () => [fireRow('x', FIRE_SCORE_FLOOR - 0.001)]),
    } as unknown as Partial<SupabaseService>);
    expect(await fireSamskaras(sb, 'thread', 1, 'text')).toBeNull();
  });

  it('returns null when the corpus is empty (top-k yields nothing)', async () => {
    const sb = fakeSupabase({
      samskaraFireTopK: vi.fn(async () => []),
    } as unknown as Partial<SupabaseService>);
    expect(await fireSamskaras(sb, 'thread', 1, 'text')).toBeNull();
  });

  it('returns null when the embed yields an empty vector', async () => {
    const sb = fakeSupabase({
      embed: vi.fn(async () => ({ data: [{ embedding: [] as number[] }] })),
    } as unknown as Partial<SupabaseService>);
    expect(await fireSamskaras(sb, 'thread', 1, 'text')).toBeNull();
  });

  it('swallows an embed failure and returns null', async () => {
    const sb = fakeSupabase({
      embed: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    } as unknown as Partial<SupabaseService>);
    await expect(fireSamskaras(sb, 'thread', 1, 'text')).resolves.toBeNull();
  });

  it('swallows a fire-RPC failure and returns null', async () => {
    const sb = fakeSupabase({
      samskaraFireTopK: vi.fn(async () => {
        throw new Error('rpc boom');
      }),
    } as unknown as Partial<SupabaseService>);
    await expect(fireSamskaras(sb, 'thread', 1, 'text')).resolves.toBeNull();
  });

  it('still returns the cohort when the fire-log write fails (priming must render)', async () => {
    const sb = fakeSupabase({
      samskaraFireTopK: vi.fn(async () => [fireRow('a', 0.7)]),
      samskaraRecordFires: vi.fn(async () => {
        throw new Error('log write boom');
      }),
    } as unknown as Partial<SupabaseService>);

    const result = await fireSamskaras(sb, 'thread', 1, 'text');
    expect(result?.fired.map((f) => f.id)).toEqual(['a']);
  });
});

describe('recordSubstrateStub', () => {
  it('forwards the thread and message ids to the substrate write', async () => {
    const recordSubstrate = vi.fn(async () => 'sid');
    const sb = fakeSupabase({
      samskaraRecordSubstrate: recordSubstrate,
    } as unknown as Partial<SupabaseService>);

    await recordSubstrateStub(sb, 'thread', 'user-msg', 'assistant-msg');
    expect(recordSubstrate).toHaveBeenCalledWith('thread', 'user-msg', 'assistant-msg');
  });

  it('swallows a write failure without throwing (fire-and-forget)', async () => {
    const sb = fakeSupabase({
      samskaraRecordSubstrate: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    } as unknown as Partial<SupabaseService>);
    await expect(recordSubstrateStub(sb, 'thread', 'user-msg', null)).resolves.toBeUndefined();
  });
});
