/**
 * Request/response shapes for the rem memory librarian. The work
 * unit is a conversation - the agent receives the batch of memories
 * referenced during recall on that conversation and looks for
 * missed relations, hidden duplicates, or contradictions that the
 * deep-sleep similarity sweep wouldn't catch (because cosine
 * distance and "user behavior treats these as belonging together"
 * are different signals).
 */

export interface RemMemoryRow {
  id: string;
  label: string;
  data: string;
  confidence: number;
}

export interface RemInput {
  /** Conversation that produced the co-occurrence signal. */
  conversationId: string;
  /**
   * Memories referenced during recall on this conversation. Ordered
   * by id for stability; the agent is expected to scan the whole
   * batch and look across all pairs, not respect any prefix order.
   */
  batch: ReadonlyArray<RemMemoryRow>;
}

export interface RemOutput {
  /** Operator-facing summary, surfaced in the log drawer. */
  finalText: string;
  /** Number of memories in the batch. */
  batchSize: number;
}

/**
 * Max conversations rem processes per 12h cycle. Bounds cost across
 * a chatty period - if the user holds a dozen recall-heavy
 * conversations in a day, rem still only attempts the oldest few.
 * The rest stay eligible and surface on the next cycle.
 */
export const REM_MAX_CONVERSATIONS_PER_CYCLE = 3;

/**
 * Hard floor on the batch size that justifies running the agent on
 * a conversation. With only a single memory referenced, there's no
 * pair to relate; the agent has nothing to do. The loop marks the
 * conversation's rows processed and moves on.
 */
export const REM_MIN_BATCH_SIZE = 2;
