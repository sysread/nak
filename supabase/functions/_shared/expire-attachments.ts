// I/O-free orchestration for the attachment-expiry sweep, the server-side
// replacement for the old browser attachment_expiry worker (Stage 2 of the
// attachments-storage migration). All I/O is injected so this runs under
// `deno test` with fakes - the edge function (expire-attachments/index.ts)
// wires the real Supabase service-role client in.
//
// The sweep: pull a bounded batch of live attachments whose owning thread has
// been dormant past the cutoff, delete their bucket objects, then mark the rows
// expired (null storage_path + stamp expired_at). Repeat until a batch comes
// back short (queue drained), the row cap is hit, or the time budget elapses;
// the next cron tick resumes. Deletion and marking are idempotent, so no
// per-row claim is needed - overlapping ticks at worst redo harmless work.

export interface ExpireBatchRow {
  id: string;
  storagePath: string;
}

export interface ExpireDeps {
  /** Next batch of expirable rows (live + dormant), at most `batchSize`. */
  listBatch: (batchSize: number) => Promise<ExpireBatchRow[]>;
  /** Delete these object keys from the attachments bucket. Idempotent. */
  deleteObjects: (paths: string[]) => Promise<void>;
  /** Null storage_path + stamp expired_at for these ids. Returns row count. */
  markExpired: (ids: string[]) => Promise<number>;
}

export interface ExpireOpts {
  batchSize: number;
  maxRows: number;
  timeBudgetMs: number;
  now?: () => number;
}

export interface ExpireSummary {
  /** Rows marked expired (objects deleted). */
  expired: number;
  /** Batches processed. */
  batches: number;
  /** True when stopped on the cap/budget rather than draining the queue. */
  bounded: boolean;
  durationMs: number;
}

export async function runExpiry(deps: ExpireDeps, opts: ExpireOpts): Promise<ExpireSummary> {
  const now = opts.now ?? Date.now;
  const start = now();
  let expired = 0;
  let batches = 0;
  let bounded = false;

  for (;;) {
    if (expired >= opts.maxRows) {
      bounded = true;
      break;
    }
    if (now() - start >= opts.timeBudgetMs) {
      bounded = true;
      break;
    }

    const remaining = opts.maxRows - expired;
    const batchSize = Math.min(opts.batchSize, remaining);
    const rows = await deps.listBatch(batchSize);
    if (rows.length === 0) break; // queue drained

    await deps.deleteObjects(rows.map((r) => r.storagePath));
    const marked = await deps.markExpired(rows.map((r) => r.id));
    expired += marked;
    batches += 1;

    // A short batch means the eligible set is exhausted for now.
    if (rows.length < batchSize) break;
  }

  return { expired, batches, bounded, durationMs: now() - start };
}
