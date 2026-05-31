// Offline unit tests for the recipe-image GC orchestration. runRecipeImageGc
// takes injected listOrphans/deleteRows/deleteObjects callbacks, so the drain
// loop, batch cap, short-batch stop, the row-vs-object counting (legacy rows
// have no object), and the re-link skip are exercised with fakes - no network,
// no Supabase, no Storage.
import { assertEquals } from '@std/assert';
import {
  runRecipeImageGc,
  type RecipeImageGcDeps,
  type OrphanRow,
} from '../_shared/recipe-image-gc.ts';

function orphans(n: number, withPath = true): OrphanRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    storagePath: withPath ? `u/sha-${i}` : null,
  }));
}

// Fake backed by a queue. listOrphans shifts up to batchSize; deleteRows
// deletes them all (records ids) and reports paths for the bucket-backed ones.
function fakeDeps(pending: OrphanRow[]): {
  deps: RecipeImageGcDeps;
  deletedRowIds: string[];
  deletedObjects: string[];
} {
  const deletedRowIds: string[] = [];
  const deletedObjects: string[] = [];
  const deps: RecipeImageGcDeps = {
    listOrphans: (batchSize) => Promise.resolve(pending.splice(0, batchSize)),
    deleteRows: (ids) => {
      deletedRowIds.push(...ids);
      // Mirror the SQL: one returned row per deleted id; paths only for the
      // ones whose synthetic storagePath is non-null (id index even here -
      // but for the simple fakes every row had a path unless stated).
      const paths = ids.map((id) => `u/sha-${id.split('-')[1]}`);
      return Promise.resolve({ deleted: ids.length, paths });
    },
    deleteObjects: (paths) => {
      deletedObjects.push(...paths);
      return Promise.resolve();
    },
  };
  return { deps, deletedRowIds, deletedObjects };
}

Deno.test('drains orphans across multiple full batches', async () => {
  const { deps, deletedRowIds, deletedObjects } = fakeDeps(orphans(250));
  const summary = await runRecipeImageGc(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 250);
  assertEquals(summary.objectsDeleted, 250);
  assertEquals(summary.batches, 3);
  assertEquals(summary.bounded, false);
  assertEquals(deletedRowIds.length, 250);
  assertEquals(deletedObjects.length, 250);
});

Deno.test('empty queue is a clean no-op', async () => {
  const { deps } = fakeDeps([]);
  const summary = await runRecipeImageGc(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 0);
  assertEquals(summary.objectsDeleted, 0);
  assertEquals(summary.batches, 0);
});

Deno.test('honors the row cap (bounded)', async () => {
  const { deps } = fakeDeps(orphans(500));
  const summary = await runRecipeImageGc(deps, {
    batchSize: 100,
    maxRows: 150,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 150);
  assertEquals(summary.bounded, true);
});

Deno.test('counts reclaimed rows even when they have no bucket object (legacy)', async () => {
  // deleteRows reports more rows deleted than object paths - a legacy orphan
  // (no storage_path) is reclaimed but has nothing to delete in the bucket.
  let served = false;
  const deps: RecipeImageGcDeps = {
    listOrphans: (n) => {
      if (served) return Promise.resolve([]);
      served = true;
      return Promise.resolve(orphans(3, false).slice(0, n)); // all legacy
    },
    deleteRows: (ids) => Promise.resolve({ deleted: ids.length, paths: [] }),
    deleteObjects: () => Promise.resolve(),
  };
  const summary = await runRecipeImageGc(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 3);
  assertEquals(summary.objectsDeleted, 0);
});

Deno.test('skips rows re-linked between list and delete', async () => {
  // listOrphans returns 5, but deleteRows only removed 3 (2 got re-linked).
  let served = false;
  const deps: RecipeImageGcDeps = {
    listOrphans: (n) => {
      if (served) return Promise.resolve([]);
      served = true;
      return Promise.resolve(orphans(5).slice(0, n));
    },
    deleteRows: (_ids) => Promise.resolve({ deleted: 3, paths: ['u/sha-0', 'u/sha-1', 'u/sha-2'] }),
    deleteObjects: () => Promise.resolve(),
  };
  const summary = await runRecipeImageGc(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.reclaimed, 3);
  assertEquals(summary.objectsDeleted, 3);
});

Deno.test('deletes rows before objects', async () => {
  const order: string[] = [];
  let served = false;
  const deps: RecipeImageGcDeps = {
    listOrphans: (n) => {
      if (served) return Promise.resolve([]);
      served = true;
      return Promise.resolve(orphans(2).slice(0, n));
    },
    deleteRows: (ids) => {
      order.push(`rows:${ids.length}`);
      return Promise.resolve({ deleted: ids.length, paths: ['u/sha-0', 'u/sha-1'] });
    },
    deleteObjects: (paths) => {
      order.push(`objects:${paths.length}`);
      return Promise.resolve();
    },
  };
  await runRecipeImageGc(deps, { batchSize: 100, maxRows: 10_000, timeBudgetMs: 10_000 });
  assertEquals(order, ['rows:2', 'objects:2']);
});
