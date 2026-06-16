// I/O-free orchestration for the attachment orphan-object GC sweep - the
// backstop that reclaims attachments-bucket objects whose row is already gone
// (a thread deletion cascaded the message_attachments row away, but SQL can't
// reach Storage to drop the object). All I/O is injected so this runs under
// `deno test` with fakes; the edge function (attachment-gc/index.ts) wires the
// real Supabase service-role client in.
//
// The sweep: list a bounded batch of orphaned object keys (bucket objects with
// no live message_attachments row), delete those objects, repeat until a batch
// comes back short (drained), the row cap, or the time budget; the next cron
// tick resumes. Deletion removes the storage.objects row too, so a deleted key
// can't reappear in the next listing - the loop makes progress and terminates.
// Idempotent throughout: deleting a gone object is a no-op, so overlapping
// ticks at worst redo harmless work and no per-object claim is needed.
//
// Simpler than recipe-image-gc: there is no row to delete here (it's already
// gone) - the orphan IS the object, so list-then-delete-object is the whole
// loop, with no row-vs-object re-check step.

export interface AttachmentGcDeps {
  /** Next batch of orphaned object keys (no live row), at most batchSize. */
  listOrphans: (batchSize: number) => Promise<string[]>;
  /** Delete these object keys from the attachments bucket. Idempotent. */
  deleteObjects: (paths: string[]) => Promise<void>;
}

export interface AttachmentGcOpts {
  batchSize: number;
  maxRows: number;
  timeBudgetMs: number;
  now?: () => number;
}

export interface AttachmentGcSummary {
  /** Orphaned objects deleted. */
  reclaimed: number;
  /** Batches processed. */
  batches: number;
  /** True when stopped on the cap/budget rather than draining the queue. */
  bounded: boolean;
  durationMs: number;
}

export async function runAttachmentGc(
  deps: AttachmentGcDeps,
  opts: AttachmentGcOpts
): Promise<AttachmentGcSummary> {
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
