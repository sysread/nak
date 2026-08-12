// Offline unit tests for the backfill orchestration. runBackfill takes injected
// claim/embed/save callbacks, so the round-robin fairness, batch cap, time
// budget, padding, and error/rate-limit policy are all exercised here with
// fakes and no network or Supabase.
import { assertEquals } from '@std/assert';
import {
  runBackfill,
  padEmbeddingForStorage,
  EMBEDDING_STORAGE_DIMS,
  type BackfillDeps,
  type ClaimedRow,
} from '../_shared/backfill.ts';

// A fake source set: one FIFO queue of input strings per source. claim() shifts
// the next id/input off the queue for that source; save() records the saved
// vector length so the test can assert padding happened.
function fakeDeps(queues: string[][], opts: {
  embed?: (input: string) => Promise<number[] | undefined>;
  save?: (i: number, id: string) => Promise<boolean>;
} = {}): { deps: BackfillDeps; saved: { sourceIndex: number; id: string; length: number }[] } {
  let counter = 0;
  const saved: { sourceIndex: number; id: string; length: number }[] = [];
  const deps: BackfillDeps = {
    claim: (sourceIndex): Promise<ClaimedRow | null> => {
      const input = queues[sourceIndex].shift();
      if (input === undefined) return Promise.resolve(null);
      return Promise.resolve({ id: `${sourceIndex}:${counter++}`, input });
    },
    embed: opts.embed ?? ((_input) => Promise.resolve([0.1, 0.2, 0.3])),
    save: async (sourceIndex, id, embedding) => {
      saved.push({ sourceIndex, id, length: embedding.length });
      return opts.save ? opts.save(sourceIndex, id) : true;
    },
  };
  return { deps, saved };
}

Deno.test('padEmbeddingForStorage zero-extends to the storage dim', () => {
  const padded = padEmbeddingForStorage([1, 2, 3]);
  assertEquals(padded.length, EMBEDDING_STORAGE_DIMS);
  assertEquals(padded.slice(0, 3), [1, 2, 3]);
  assertEquals(padded[3], 0);
  assertEquals(padded[EMBEDDING_STORAGE_DIMS - 1], 0);
});

Deno.test('runBackfill drains every source fairly and pads before saving', async () => {
  const { deps, saved } = fakeDeps([
    ['a1', 'a2'],
    ['b1'],
  ]);
  const summary = await runBackfill(deps, {
    sourceCount: 2,
    maxRows: 100,
    timeBudgetMs: 10_000,
    now: () => 0, // never advance: only the empty-queue and maxRows guards apply
  });
  assertEquals(summary.embedded, 3);
  assertEquals(saved.length, 3);
  // Every saved vector was padded to the storage dimension.
  assertEquals(saved.every((s) => s.length === EMBEDDING_STORAGE_DIMS), true);
  // Round-robin: source 0 and source 1 both got drained, not one starving the other.
  assertEquals(saved.filter((s) => s.sourceIndex === 0).length, 2);
  assertEquals(saved.filter((s) => s.sourceIndex === 1).length, 1);
});

Deno.test('runBackfill stops at the batch cap', async () => {
  const { deps } = fakeDeps([Array.from({ length: 10 }, (_v, i) => `m${i}`)]);
  const summary = await runBackfill(deps, {
    sourceCount: 1,
    maxRows: 4,
    timeBudgetMs: 10_000,
    now: () => 0,
  });
  assertEquals(summary.embedded, 4);
});

Deno.test('runBackfill stops when the time budget lapses', async () => {
  // Each embed advances the clock by 1500ms against a 1000ms budget, so exactly
  // one row fits before the next iteration's budget check trips.
  let clock = 0;
  const { deps } = fakeDeps([Array.from({ length: 10 }, (_v, i) => `m${i}`)], {
    embed: () => {
      clock += 1500;
      return Promise.resolve([0.1, 0.2, 0.3]);
    },
  });
  const summary = await runBackfill(deps, {
    sourceCount: 1,
    maxRows: 100,
    now: () => clock,
    timeBudgetMs: 1000,
  });
  assertEquals(summary.embedded, 1);
});

Deno.test('runBackfill stops immediately when all sources are empty', async () => {
  const { deps, saved } = fakeDeps([[], []]);
  const summary = await runBackfill(deps, {
    sourceCount: 2,
    maxRows: 100,
    timeBudgetMs: 10_000,
    now: () => 0,
  });
  assertEquals(summary.embedded, 0);
  assertEquals(saved.length, 0);
});

Deno.test('runBackfill counts save-rejected rows and keeps going', async () => {
  const { deps } = fakeDeps([['a', 'b']], { save: () => Promise.resolve(false) });
  const summary = await runBackfill(deps, {
    sourceCount: 1,
    maxRows: 100,
    timeBudgetMs: 10_000,
    now: () => 0,
  });
  assertEquals(summary.embedded, 0);
  assertEquals(summary.rejected, 2);
});

Deno.test('runBackfill counts an empty embedding as no-embedding and skips the save', async () => {
  const { deps, saved } = fakeDeps([['a']], { embed: () => Promise.resolve(undefined) });
  const summary = await runBackfill(deps, {
    sourceCount: 1,
    maxRows: 100,
    timeBudgetMs: 10_000,
    now: () => 0,
  });
  assertEquals(summary.noEmbedding, 1);
  assertEquals(summary.embedded, 0);
  assertEquals(saved.length, 0);
});

Deno.test('runBackfill bails the whole invocation on a rate-limit error', async () => {
  const { deps } = fakeDeps([['a', 'b', 'c']], {
    embed: () => Promise.reject({ kind: 'rate_limit' }),
  });
  const summary = await runBackfill(deps, {
    sourceCount: 1,
    maxRows: 100,
    timeBudgetMs: 10_000,
    now: () => 0,
  });
  assertEquals(summary.rateLimited, true);
  assertEquals(summary.embedded, 0);
});

Deno.test('runBackfill shrinks and retries an input the embedder rejects as too long', async () => {
  // A chunk whose content is denser than the chars-per-token estimate
  // (pasted base64, a wall of UUIDs) overflows the model's ceiling.
  // Without the shrink it is re-claimed and re-rejected on every tick,
  // forever, and never gets a vector.
  const attempts: number[] = [];
  const { deps, saved } = fakeDeps([['x'.repeat(16_000)]], {
    embed: (input) => {
      attempts.push(input.length);
      if (input.length > 4_000) {
        return Promise.reject(
          new Error('Input text exceeds the maximum token limit of 8192 tokens'),
        );
      }
      return Promise.resolve([0.1, 0.2, 0.3]);
    },
  });
  const summary = await runBackfill(deps, {
    sourceCount: 1,
    maxRows: 100,
    timeBudgetMs: 10_000,
    now: () => 0,
  });
  assertEquals(summary.embedded, 1);
  assertEquals(summary.errors, 0);
  assertEquals(attempts, [16_000, 8_000, 4_000]);
  assertEquals(saved.length, 1);
});

Deno.test('runBackfill gives up shrinking before the vector stops describing the row', async () => {
  // A bad vector is worse than a missing one - it ranks, wrongly. So the
  // shrink floors out and the row is left for a human to notice rather
  // than embedded from a scrap of its content.
  const attempts: number[] = [];
  const { deps, saved } = fakeDeps([['x'.repeat(16_000)]], {
    embed: (input) => {
      attempts.push(input.length);
      return Promise.reject(new Error('Input text exceeds the maximum token limit'));
    },
  });
  const summary = await runBackfill(deps, {
    sourceCount: 1,
    maxRows: 100,
    timeBudgetMs: 10_000,
    now: () => 0,
  });
  assertEquals(summary.embedded, 0);
  assertEquals(summary.errors, 1);
  assertEquals(saved.length, 0);
  // Halving stops once the next halving would go under the floor.
  assertEquals(attempts[attempts.length - 1] > 250, true);
});

Deno.test('runBackfill does not shrink on unrelated embed failures', async () => {
  const attempts: number[] = [];
  const { deps } = fakeDeps([['a'.repeat(16_000)]], {
    embed: (input) => {
      attempts.push(input.length);
      return Promise.reject(new Error('connection reset'));
    },
  });
  const summary = await runBackfill(deps, {
    sourceCount: 1,
    maxRows: 100,
    timeBudgetMs: 10_000,
    now: () => 0,
  });
  assertEquals(summary.errors, 1);
  assertEquals(attempts.length, 1);
});
