/**
 * Request/response shapes for the journaling agent. Kept in their own
 * file so the loop and worker can import the types without reaching
 * into the agent class (which pulls in the memory-adjacent
 * `runHeadlessToolLoop` path).
 */

/**
 * Hard cap on the agent's Markdown body. Lives here rather than next
 * to the upsert call site because the embeddings worker also clamps
 * to this length when building the journal entry's vector text - both
 * sides agreeing on one constant keeps a long entry from getting
 * truncated differently between storage and embedding.
 */
export const MAX_JOURNAL_CONTENT_CHARS = 16000;

export interface JournalInput {
  /** Thread to journal - claimed by the worker before this runs. */
  threadId: string;
  /**
   * Terminal assistant message the claim was made against. The agent
   * slices thread history at this id so a race where the user added
   * more turns mid-journal simply re-queues the thread next cycle.
   * Also passed to the atomic upsert+mark RPC so the pointer advance
   * lands on this exact message.
   */
  terminalMsgId: string;
  /**
   * The lease holder's id - the random per-worker token already
   * stored on `threads.journal_claim_holder` when the claim landed.
   * Forwarded to the atomic upsert+mark RPC so the mark step can
   * verify the claim is still ours before advancing the pointer.
   */
  holderId: string;
  /**
   * Conversation-start day in the user's local timezone (YYYY-MM-DD,
   * computed by the worker via `dateInZone(thread.created_at, tz)`).
   * Pinned on insert and not updated on conflict - the entry's date
   * is whichever day the conversation started, not whatever day the
   * worker happens to be processing it.
   */
  entryDate: string;
  /**
   * Cached context-recall payload at claim time (jsonb verbatim from
   * the threads row). The agent runs `coerceContextRecallPayload`
   * against it to decide between reusing the cached note vs. firing
   * the recall pipeline fresh. Always present on the field because
   * the claim RPC returns null when the chat-loop has never run a
   * recall on the thread; the agent treats null and a malformed-
   * shape payload identically (= cold cache, run fresh).
   */
  contextRecallPayload: unknown;
}

export interface JournalOutput {
  /** Final text the model settled on (the raw JSON it produced). */
  finalText: string;
  /** Number of messages the agent saw on round 1 (observability). */
  inputMessageCount: number;
  /** Whether the agent actually wrote an entry this run. */
  entryWritten: boolean;
  /**
   * The model's one-sentence rationale for whether this conversation
   * merits a journal entry, copied straight out of the structured-
   * response payload. Set on every non-parse-failure run - both write
   * and skip paths - so the worker log can show the decision-with-why
   * regardless of which way the model went. Null only when JSON parsing
   * failed (the run gets `entryWritten=false` and the loop reads the
   * fallback message off `finalText`).
   */
  reasoning: string | null;
}
