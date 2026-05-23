/**
 * Request/response shapes for the deep-sleep memory librarian. Kept
 * in their own file so the loop and worker can import the types
 * without reaching into the agent class (which pulls in
 * `runHeadlessToolLoop` and the `memoryLibrarianToolbox`).
 */

export interface DeepSleepMemoryRow {
  id: string;
  label: string;
  data: string;
  confidence: number;
  /**
   * Cosine similarity to the seed memory, in [0, 1]. The seed itself
   * appears in the batch with score = 1.0 so the prompt can render a
   * uniform list. Used by the agent to decide consolidate-vs-relate-
   * vs-leave - the prompt frames 0.95+ as "almost certainly the same
   * fact" and 0.80-0.90 as "may just be related."
   */
  score: number;
}

export interface DeepSleepInput {
  /**
   * Seed memory followed by its top-k similarity neighbors above the
   * threshold. The seed always appears first; neighbors are ordered
   * by descending score. Each item carries the score so the agent
   * can tier its own confidence on consolidate decisions.
   */
  batch: ReadonlyArray<DeepSleepMemoryRow>;
}

export interface DeepSleepOutput {
  /**
   * The model's final (post-tool-loop) text. Used as the operator-
   * facing reasoning surfaced in the log drawer - the prompt's "Final
   * reply" block instructs the agent to emit a one-or-two-sentence
   * summary of what it merged, related, or left alone. Trimmed and
   * inlined as `reasoning="..."` on the deep-sleep-finished log line.
   */
  finalText: string;
  /** Number of memories in the batch (seed + neighbors). */
  batchSize: number;
}

/**
 * Cosine-similarity threshold for a neighbor to land in the batch.
 * Below this, the pair is too dissimilar for the librarian to spend
 * tokens reasoning about - reflection's "search before create"
 * already covers the obvious-near-duplicate case.
 *
 * 0.80 is a medium gate: high enough to filter out unrelated
 * memories, low enough to let "related but distinct" pairs through
 * for the relation-edge pass. Tuned with score-in-prompt so the
 * agent can self-tier within the batch.
 */
export const DEEP_SLEEP_MIN_SIMILARITY = 0.8;

/**
 * Max number of neighbors (excluding the seed) the loop fetches per
 * cycle. The seed + 8 neighbors is a comfortable batch for the
 * agent's reasoning loop without blowing the prompt budget on the
 * embedded label/data text.
 */
export const DEEP_SLEEP_MAX_NEIGHBORS = 8;

/**
 * Hard floor on the batch size that justifies running the agent.
 * Below this (the seed alone, or the seed plus one neighbor that's
 * already an obvious self-similarity hit), the consolidation
 * decision is too narrow to need an LLM. The loop short-circuits to
 * 'too-small' and just stamps the seed's visit timestamp.
 */
export const DEEP_SLEEP_MIN_BATCH_SIZE = 2;
