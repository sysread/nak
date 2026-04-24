/**
 * Request/response shapes for the journaling agent. Kept in their own
 * file so the loop and worker can import the types without reaching
 * into the agent class (which pulls in the memory-adjacent
 * `runHeadlessToolLoop` path).
 */

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
  /** Final text the model settled on. Usually a single filler word per prompt. */
  finalText: string;
  /** Number of messages the agent saw on round 1 (observability). */
  inputMessageCount: number;
  /** Whether the agent actually wrote an entry this run. */
  entryWritten: boolean;
}
