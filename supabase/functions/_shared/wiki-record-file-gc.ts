// I/O-free orchestration for the wiki-record-files orphan-object GC sweep - the
// backstop that reclaims wiki-record-files bucket objects whose row is already
// gone (a record/article delete cascaded the wiki_record_files row away, but
// SQL can't reach Storage to drop the object). All I/O is injected so this runs
// under `deno test` with fakes; the edge function (wiki-record-file-gc/index.ts)
// wires the real Supabase service-role client in.
//
// The sweep: list a bounded batch of orphaned object keys (bucket objects with
// no wiki_record_files row), delete those objects, repeat until a batch comes
// back short (drained), the row cap, or the time budget; the next cron tick
// resumes. Deletion removes the storage.objects row too, so a deleted key can't
// reappear in the next listing - the loop makes progress and terminates.
// Idempotent throughout: deleting a gone object is a no-op, so overlapping ticks
// at worst redo harmless work and no per-object claim is needed.
//
// Same shape as attachment-gc: the orphan IS the object (the row is already
// gone), so list-then-delete-object is the whole loop, no row-vs-object
// re-check step.

export interface WikiRecordFileGcDeps {
  /** Next batch of orphaned object keys (no row), at most batchSize. */
  listOrphans: (batchSize: number) => Promise<string[]>;
  /** Delete these object keys from the wiki-record-files bucket. Idempotent. */
  deleteObjects: (paths: string[]) => Promise<void>;
}

export interface WikiRecordFileGcOpts {
  batchSize: number;
  maxRows: number;
  timeBudgetMs: number;
  now?: () => number;
}

export interface WikiRecordFileGcSummary {
  /** Orphaned objects deleted. */
  reclaimed: number;
  /** Batches processed. */
  batches: number;
  /** True when stopped on the cap/budget rather than draining the queue. */
  bounded: boolean;
  durationMs: number;
}

export async function runWikiRecordFileGc(
  deps: WikiRecordFileGcDeps,
  opts: WikiRecordFileGcOpts
): Promise<WikiRecordFileGcSummary> {
  const now = opts.now ?? Date.now;
  const start = now();
  let reclaimed = 0;
  let batches = 0;
  let bounded = false;

  for (;;) {
    if (reclaimed >= opts.maxRows || now() - start >= opts.timeBudgetMs) {
      bounded = true;
      break;
    }
    const batchSize = Math.min(opts.batchSize, opts.maxRows - reclaimed);
    const paths = await deps.listOrphans(batchSize);
    if (paths.length === 0) break; // queue drained

    await deps.deleteObjects(paths);
    reclaimed += paths.length;
    batches += 1;

    // A short batch means the eligible set is exhausted for now.
    if (paths.length < batchSize) break;
  }

  return { reclaimed, batches, bounded, durationMs: now() - start };
}
