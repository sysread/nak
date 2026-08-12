// Server-side embedding backfill orchestration.
//
// This is the claim -> embed -> pad -> save loop that the browser embeddings
// worker used to run, relocated behind the venice edge function and driven by
// pg_cron instead of an open tab. The browser worker, its Web Lock, and its
// per-user lease are gone; the server owns backfill now. See
// docs/dev/in-progress/venice-edge-functions/embeddings.md.
//
// runBackfill is deliberately I/O-free: it takes injected claim/embed/save
// callbacks so the round-robin, batch-cap, time-budget, and error policy are
// unit-testable under `deno test` with fakes and no network. venice/index.ts
// wires the real deps (Supabase service-role RPCs + veniceEmbed) into it.

// Native output dimension of the embedding model (bge-m3 emits 1024) and the
// wider storage column the vector is zero-extended into. Mirrors
// VENICE_EMBEDDING_MODEL / VENICE_EMBEDDING_DIMS / EMBEDDING_STORAGE_DIMS in
// src/lib/models/index.ts - kept in sync by hand because the Deno island does
// not import from the Vite app (see _shared/venice.ts).
export const VENICE_EMBEDDING_MODEL = 'text-embedding-bge-m3';
export const EMBEDDING_STORAGE_DIMS = 2048;

/**
 * Zero-extend a Venice embedding to the storage dimension. Cosine similarity is
 * invariant under zero-extension, so a padded vector ranks identically to its
 * native prefix. A longer-than-storage input is a bug (stale dim or someone
 * else's vector), so we throw rather than silently truncate - a truncated
 * vector would look like a correctness bug dressed up as a perf regression when
 * searches start returning the wrong rows. Mirrors padEmbeddingForStorage in
 * src/lib/models/index.ts.
 */
export function padEmbeddingForStorage(embedding: readonly number[]): number[] {
  if (embedding.length > EMBEDDING_STORAGE_DIMS) {
    throw new Error(
      `embedding length ${embedding.length} exceeds storage dim ${EMBEDDING_STORAGE_DIMS}`
    );
  }
  if (embedding.length === EMBEDDING_STORAGE_DIMS) return embedding.slice();
  const padded = new Array<number>(EMBEDDING_STORAGE_DIMS).fill(0);
  for (let i = 0; i < embedding.length; i++) padded[i] = embedding[i];
  return padded;
}

/** A row claimed for embedding: an id plus the composed input string. */
export interface ClaimedRow {
  id: string;
  input: string;
}

export interface BackfillDeps {
  /**
   * Claim the next pending row for the source at `sourceIndex`, stamping it
   * with the invocation's holder id + claim TTL. Returns null when that source
   * has nothing pending right now.
   */
  claim: (sourceIndex: number) => Promise<ClaimedRow | null>;
  /**
   * Produce an embedding for `input`. Returns the native-dimension vector, or
   * undefined/empty when Venice returned no vector. Throws on failure - a
   * rate-limit is recognized via `isRateLimit` so the invocation can bail
   * early and let the next cron tick resume.
   */
  embed: (input: string) => Promise<number[] | undefined>;
  /**
   * Save the (already padded) embedding if our claim still holds. Returns false
   * when the row was edited, the claim lapsed, or the row was deleted - a normal
   * skip, not an error.
   */
  save: (sourceIndex: number, id: string, embedding: number[]) => Promise<boolean>;
}

export interface BackfillOptions {
  /** Number of sources to round-robin over (EMBED_SOURCES.length). */
  sourceCount: number;
  /** Stop claiming once this many rows have been processed this invocation. */
  maxRows: number;
  /** Stop claiming once this much wall-clock has elapsed. pg_net confirms
   *  dispatch, not completion, and the edge runtime has its own wall-clock
   *  limit, so each invocation self-bounds and relies on the claim protocol to
   *  resume on the next tick. */
  timeBudgetMs: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Recognize a rate-limit error so the loop can stop early. Defaults to
   *  matching VeniceError's `kind === 'rate_limit'`. */
  isRateLimit?: (err: unknown) => boolean;
  /** Recognize an input-too-long rejection so the row can be shrunk and
   *  retried rather than failing forever. Defaults to matching the
   *  embeddings endpoint's message. */
  isInputTooLong?: (err: unknown) => boolean;
}

export interface BackfillSummary {
  embedded: number;
  rejected: number;
  noEmbedding: number;
  errors: number;
  rateLimited: boolean;
  durationMs: number;
}

function defaultIsRateLimit(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { kind?: unknown }).kind === 'rate_limit'
  );
}

/**
 * Venice rejects an over-long embedding input with a 400 whose message
 * names the ceiling ("Input text exceeds the maximum token limit of
 * 8192 tokens"). Matched on the message because the wire body carries
 * no machine-readable code for it - a `kind` check like the rate-limit
 * one above has nothing to key on.
 */
function defaultIsInputTooLong(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /maximum token limit|exceeds the maximum|context length/i.test(message);
}

/**
 * Floor on the shrink retry. Below this an input has lost so much of
 * its content that the vector no longer describes the row, and a bad
 * vector is worse than a missing one - it ranks, wrongly.
 */
const MIN_EMBED_INPUT_CHARS = 500;

/**
 * Embed `input`, halving it on an input-too-long rejection.
 *
 * Chunk sizing is an estimate: Venice exposes no tokenizer, so the
 * chunker budgets characters against a conservative chars-per-token
 * divisor (see _shared/thread-transcript.ts). Content denser than the
 * estimate - a pasted base64 blob, a wall of UUIDs - beats it and gets
 * rejected. Without this retry such a row is claimed, fails, and is
 * re-claimed on every subsequent tick forever: permanently unembedded
 * and burning a slot each time.
 *
 * Halving rather than trimming to a computed size because the rejection
 * does not say how far over the input was, and it mirrors the shrink
 * loop in venice/agents/_curation_helpers.ts.
 */
async function embedWithShrink(
  embed: (input: string) => Promise<number[] | undefined>,
  input: string,
  isInputTooLong: (err: unknown) => boolean,
): Promise<number[] | undefined> {
  let text = input;
  for (;;) {
    try {
      return await embed(text);
    } catch (err) {
      if (!isInputTooLong(err) || text.length <= MIN_EMBED_INPUT_CHARS) throw err;
      text = text.slice(0, Math.floor(text.length / 2));
    }
  }
}

/**
 * Drain pending embeddings across every source until the queue empties, the
 * batch cap is hit, the time budget lapses, or Venice rate-limits us.
 *
 * Round-robin (one claim attempt per source per pass) is what keeps a large
 * memories backlog from starving threads/recipes/wiki - the same fairness the
 * browser worker needed the moment it had more than one source. A full pass
 * that claims nothing from any source means the queue is drained: we stop
 * rather than spin.
 */
export async function runBackfill(
  deps: BackfillDeps,
  opts: BackfillOptions
): Promise<BackfillSummary> {
  const now = opts.now ?? Date.now;
  const isRateLimit = opts.isRateLimit ?? defaultIsRateLimit;
  const isInputTooLong = opts.isInputTooLong ?? defaultIsInputTooLong;
  const start = now();
  const summary: BackfillSummary = {
    embedded: 0,
    rejected: 0,
    noEmbedding: 0,
    errors: 0,
    rateLimited: false,
    durationMs: 0,
  };

  let processed = 0;
  let drained = false;
  while (!drained) {
    if (processed >= opts.maxRows) break;
    if (now() - start >= opts.timeBudgetMs) break;

    let claimedThisPass = false;
    for (let i = 0; i < opts.sourceCount; i++) {
      if (processed >= opts.maxRows) break;
      if (now() - start >= opts.timeBudgetMs) break;

      let row: ClaimedRow | null;
      try {
        row = await deps.claim(i);
      } catch {
        // A claim failure is transient (network, lock contention). Skip this
        // source for the pass; the next tick retries.
        summary.errors++;
        continue;
      }
      if (!row) continue; // nothing pending for this source right now
      claimedThisPass = true;

      let vector: number[] | undefined;
      try {
        vector = await embedWithShrink(deps.embed, row.input, isInputTooLong);
      } catch (err) {
        if (isRateLimit(err)) {
          // Back off the whole invocation - the next cron tick resumes from the
          // same claim. The row's claim TTL lapses so it is re-claimable.
          summary.rateLimited = true;
          summary.durationMs = now() - start;
          return summary;
        }
        summary.errors++;
        continue;
      }
      if (!vector || vector.length === 0) {
        summary.noEmbedding++;
        processed++;
        continue;
      }

      let saved: boolean;
      try {
        saved = await deps.save(i, row.id, padEmbeddingForStorage(vector));
      } catch {
        summary.errors++;
        continue;
      }
      if (saved) summary.embedded++;
      else summary.rejected++;
      processed++;
    }

    // No source had work this pass -> the queue is drained.
    if (!claimedThisPass) drained = true;
  }

  summary.durationMs = now() - start;
  return summary;
}
