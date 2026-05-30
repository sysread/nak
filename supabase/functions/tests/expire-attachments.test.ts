// Offline unit tests for the attachment-expiry orchestration. runExpiry takes
// injected listBatch/deleteObjects/markExpired callbacks, so the drain loop,
// batch cap, short-batch stop, and budget exit are exercised with fakes - no
// network, no Supabase, no Storage.
import { assertEquals } from '@std/assert';
import { runExpiry, type ExpireDeps, type ExpireBatchRow } from '../_shared/expire-attachments.ts';

// A fake backed by a queue of pending rows. listBatch shifts up to `batchSize`
// off the front; deleteObjects + markExpired record what they saw.
function fakeDeps(
  pending: ExpireBatchRow[]
): {
  deps: ExpireDeps;
  deleted: string[];
  marked: string[];
} {
  const deleted: string[] = [];
  const marked: string[] = [];
  const deps: ExpireDeps = {
    listBatch: (batchSize) => Promise.resolve(pending.splice(0, batchSize)),
    deleteObjects: (paths) => {
      deleted.push(...paths);
      return Promise.resolve();
    },
    markExpired: (ids) => {
      marked.push(...ids);
      return Promise.resolve(ids.length);
    },
  };
  return { deps, deleted, marked };
}

function rows(n: number): ExpireBatchRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, storagePath: `u/id-${i}/f` }));
}

Deno.test('drains the queue across multiple full batches', async () => {
  const { deps, deleted, marked } = fakeDeps(rows(250));
  const summary = await runExpiry(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.expired, 250);
  assertEquals(summary.batches, 3); // 100 + 100 + 50 (short -> stop)
  assertEquals(summary.bounded, false);
  assertEquals(deleted.length, 250);
  assertEquals(marked.length, 250);
});

Deno.test('stops at a short batch without an extra empty call', async () => {
  const { deps } = fakeDeps(rows(40));
  const summary = await runExpiry(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.expired, 40);
  assertEquals(summary.batches, 1);
  assertEquals(summary.bounded, false);
});

Deno.test('empty queue is a clean no-op', async () => {
  const { deps, deleted } = fakeDeps([]);
  const summary = await runExpiry(deps, {
    batchSize: 100,
    maxRows: 10_000,
    timeBudgetMs: 10_000,
  });
  assertEquals(summary.expired, 0);
  assertEquals(summary.batches, 0);
  assertEquals(deleted.length, 0);
});

Deno.test('honors the row cap (bounded), leaving the rest for the next tick', async () => {
  const { deps, marked } = fakeDeps(rows(500));
  const summary = await runExpiry(deps, {
    batchSize: 100,
    maxRows: 150,
    timeBudgetMs: 10_000,
  });
  // 100 then a 50-row batch (capped by remaining) reaches the cap.
  assertEquals(summary.expired, 150);
  assertEquals(summary.bounded, true);
  assertEquals(marked.length, 150);
});

Deno.test('deletes objects before marking rows expired', async () => {
  const order: string[] = [];
  const deps: ExpireDeps = {
    listBatch: (() => {
      let served = false;
      return (n: number) => {
        if (served) return Promise.resolve([]);
        served = true;
        return Promise.resolve(rows(3).slice(0, n));
      };
    })(),
    deleteObjects: (paths) => {
      order.push(`delete:${paths.length}`);
      return Promise.resolve();
    },
    markExpired: (ids) => {
      order.push(`mark:${ids.length}`);
      return Promise.resolve(ids.length);
    },
  };
  await runExpiry(deps, { batchSize: 100, maxRows: 10_000, timeBudgetMs: 10_000 });
  assertEquals(order, ['delete:3', 'mark:3']);
});
