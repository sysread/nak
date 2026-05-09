/**
 * Request/response shapes for the wiki librarian. Kept in their own
 * file so the loop and worker can import the types without reaching
 * into the agent class (which pulls in `runHeadlessToolLoop` and the
 * `wikiLibrarianToolbox`).
 */

export interface WikiLibrarianInput {
  /**
   * Snapshot of every article in the user's wiki at the time the
   * librarian was claimed. The agent uses this to plan its review -
   * which titles to inspect, which look like duplicates, which
   * subjects appear under multiple titles. Each item is a compact
   * projection (title + a head-of-content excerpt) rather than the
   * full body, so the prompt doesn't blow past the model's window
   * when the user has dozens of articles. The agent fetches full
   * bodies on demand via wiki_search.
   */
  articles: ReadonlyArray<{
    id: string;
    title: string;
    /** First N chars of content; full body via wiki_search by id. */
    excerpt: string;
  }>;
}

export interface WikiLibrarianOutput {
  /** Final post-tool-loop text. Discarded by production callers. */
  finalText: string;
  /** Number of articles in the snapshot. Surface for observability. */
  articleCount: number;
}

/**
 * Hard cap on the per-article excerpt the prompt carries. 400 chars
 * is roughly enough to convey "what's this article about" without
 * blowing past the model's window when the user has a hundred
 * articles. Full bodies are still reachable via wiki_search.
 */
export const LIBRARIAN_EXCERPT_CHARS = 400;

/**
 * Skip a librarian run when the user has fewer than this many
 * articles. There's nothing to consolidate when the wiki is small,
 * and the run would just spend Venice tokens to confirm that.
 */
export const LIBRARIAN_MIN_ARTICLES = 3;
