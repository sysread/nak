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
   */
  terminalMsgId: string;
  /** Today's YYYY-MM-DD in the user's local timezone (computed by the worker). */
  entryDate: string;
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
