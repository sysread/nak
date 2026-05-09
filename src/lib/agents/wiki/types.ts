/**
 * Request/response shapes for the autonomous wiki agent. Kept in
 * their own file so the loop and worker can import the types without
 * reaching into the agent class (which pulls in `runHeadlessToolLoop`
 * and the wikiToolbox).
 */

export interface WikiInput {
  /** Thread to process - claimed by the worker before this runs. */
  threadId: string;
  /**
   * Terminal assistant message the claim was made against. The agent
   * slices thread history at this id so a race where the user added
   * more turns mid-run simply queues the thread for the next cycle.
   * Also stamped into `last_wiki_processed_msg_id` by the loop's
   * mark-step after the agent returns.
   */
  terminalMsgId: string;
}

export interface WikiOutput {
  /**
   * The model's final (post-tool-loop) text. Always discarded by
   * production callers - "reply with a single word" per the prompt -
   * but returned here for debug logs and test assertions.
   */
  finalText: string;
  /**
   * Number of messages fed to the model on round 1, before the
   * model's own turns extended the conversation. Surface it for
   * observability - a wiki run over 50 messages is meaningfully
   * different from one over 5.
   */
  inputMessageCount: number;
}
