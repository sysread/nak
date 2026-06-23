// Offline unit tests for the wiki-record-files orphan-object GC orchestration.
// runWikiRecordFileGc takes injected listOrphans/deleteObjects callbacks, so the
// drain loop, batch cap, and short-batch stop are exercised with fakes - no
// network, no Supabase, no Storage.
import { assertEquals } from '@std/assert';
import {
  runWikiRecordFileGc,
  type WikiRecordFileGcDeps,
} from '../_shared/wiki-record-file-gc.ts';

function keys(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `u/rf-${i}/crumb.jpg`);
}

// Fake backed by a queue. listOrphans shifts up to batchSize; deleteObjects
// records the keys it was handed.
function fakeDeps(pending: string[]): {
  deps: WikiRecordFileGcDeps;
  deletedObjects: string[];
} {
  const deletedObjects: string[] = [];
  const deps: WikiRecordFileGcDeps = {
    listOrphans: (batchSize) => Promise.resolve(pending.splice(0, batchSize)),
    deleteObjects: (paths) => {
      deletedObjects.push(...paths);
      return Promise.resolve();
    },
  };
  return { deps, deletedObjects };
}

Deno.test('drains orphans across multiple full batches', async () => {
  const { deps, deletedObjects } = fakeDeps(keys(250));
  const summary = await runWikiRecordFileGc(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 250);
  assertEquals(summary.batches, 3);
  assertEquals(summary.bounded, false);
  assertEquals(deletedObjects.length, 250);
});

Deno.test('empty queue is a clean no-op', async () => {
  const { deps, deletedObjects } = fakeDeps([]);
  const summary = await runWikiRecordFileGc(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 0);
  assertEquals(summary.batches, 0);
  assertEquals(deletedObjects.length, 0);
});

Deno.test('a short batch stops the loop (eligible set exhausted)', async () => {
  const { deps } = fakeDeps(keys(40));
  const summary = await runWikiRecordFileGc(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 40);
  assertEquals(summary.batches, 1);
  assertEquals(summary.bounded, false);
});

Deno.test('honors the row cap (bounded)', async () => {
  const { deps } = fakeDeps(keys(500));
  const summary = await runWikiRecordFileGc(deps, {
    batchSize: 100,
    maxRows: 150,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 150);
  assertEquals(summary.bounded, true);
});

Deno.test('honors the time budget (bounded)', async () => {
  // now() advances past the budget after the first batch, so the loop stops
  // before draining the queue.
  let t = 0;
  const deps: WikiRecordFileGcDeps = {
    listOrphans: (batchSize) => Promise.resolve(keys(batchSize)),
    deleteObjects: () => Promise.resolve(),
  };
  const summary = await runWikiRecordFileGc(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 50,
    now: () => (t += 100),
  });
  assertEquals(summary.bounded, true);
});
