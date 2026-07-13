// I/O-free orchestration for the recipe-image GC sweep - the idempotent
// server-side replacement for the old AFTER DELETE orphan trigger (see
// docs/dev/in-progress/recipe-images-storage-migration.md). All I/O is
// injected so this runs under `deno test` with fakes; the edge function
// (recipe-image-gc/index.ts) wires the real Supabase service-role client.
//
// The sweep: list a bounded batch of orphaned recipe_images (no link),
// delete the rows that are STILL orphaned (re-checked under the delete, to
// skip any re-linked between list and delete), then delete the bucket
// objects for the rows actually removed. Row-then-object ordering means we
// only ever delete an object whose row we definitively removed. Repeat
// until a batch comes back short (drained), the row cap, or the time
// budget; the next cron tick resumes. Idempotent throughout.
//
// The loop itself is table-agnostic - every table/bucket specific
// lives in the injected deps - so grocery-image-gc/index.ts reuses
// this driver too, with the grocery orphan RPCs and bucket injected.
// If you change the drain semantics here, both sweeps change.

export interface OrphanRow {
  id: string;
  /** Bucket key, or null for a legacy (un-migrated) row with no object. */
  storagePath: string | null;
}

export interface DeleteRowsResult {
  /** Rows actually deleted (still-orphaned), including legacy rows with
   *  no bucket object. */
  deleted: number;
  /** Bucket keys of the deleted rows that had one (legacy rows omitted). */
  paths: string[];
}

export interface RecipeImageGcDeps {
  /** Next batch of orphaned recipe_images (no link), at most batchSize. */
  listOrphans: (batchSize: number) => Promise<OrphanRow[]>;
  /** Delete the still-orphaned rows among these ids (re-checked); report
   *  the count removed and the bucket keys among them. */
  deleteRows: (ids: string[]) => Promise<DeleteRowsResult>;
  /** Delete these object keys from the recipe-images bucket. Idempotent. */
  deleteObjects: (paths: string[]) => Promise<void>;
}

export interface RecipeImageGcOpts {
  batchSize: number;
  maxRows: number;
  timeBudgetMs: number;
  now?: () => number;
}

export interface RecipeImageGcSummary {
  /** recipe_images rows reclaimed. */
  reclaimed: number;
  /** Bucket objects deleted (<= reclaimed; legacy rows have none). */
  objectsDeleted: number;
  batches: number;
  bounded: boolean;
  durationMs: number;
}

export async function runRecipeImageGc(
  deps: RecipeImageGcDeps,
  opts: RecipeImageGcOpts
): Promise<RecipeImageGcSummary> {
  const now = opts.now ?? Date.now;
  const start = now();
  let reclaimed = 0;
  let objectsDeleted = 0;
  let batches = 0;
  let bounded = false;

  for (;;) {
    if (reclaimed >= opts.maxRows || now() - start >= opts.timeBudgetMs) {
      bounded = true;
      break;
    }
    const batchSize = Math.min(opts.batchSize, opts.maxRows - reclaimed);
    const orphans = await deps.listOrphans(batchSize);
    if (orphans.length === 0) break;

    const { deleted, paths } = await deps.deleteRows(orphans.map((o) => o.id));
    reclaimed += deleted;
    if (paths.length > 0) {
      await deps.deleteObjects(paths);
      objectsDeleted += paths.length;
    }
    batches += 1;

    if (orphans.length < batchSize) break;
  }

  return { reclaimed, objectsDeleted, batches, bounded, durationMs: now() - start };
}
