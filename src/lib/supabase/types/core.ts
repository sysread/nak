/**
 * Cross-domain row/shape types for the Supabase data layer: pagination
 * primitives, the topic-vocabulary shapes shared by threads / memories /
 * recipes, and the generic agent-run progress + in-flight-lease unions
 * that serve every background fleet. Domain-specific row types live in
 * the sibling modules; this is the shared vocabulary. Re-exported through
 * `../../supabase.ts` so consumers keep importing from `$lib/supabase`.
 */

// --- appended verbatim from the original supabase.ts type block ---
/**
 * One live step event from a server-side agent run, as published to
 * the agent-runs:<userId> Broadcast channel by the venice function.
 * Mirror of the per-agent progress unions: `preparing` (whose count
 * field names the agent's work unit - articles for the wiki
 * librarian, conversations for rem, the memory batch for
 * deep-sleep), the runner's `thinking` / `tool` events, and a
 * closing `done`. `runId` is the demux key - every event carries the
 * id the client minted for its run, so concurrent runs (or a stale
 * subscription) can't cross streams.
 */
export type AgentRunProgressEvent = { runId: string } & (
  | {
      kind: 'preparing';
      articleCount?: number;
      conversationCount?: number;
      batchSize?: number;
    }
  | { kind: 'thinking'; round: number }
  | { kind: 'tool'; name: string; activity: string; ok: boolean; ms: number }
  | { kind: 'done'; ok: boolean }
  // Terminal outcome for a DETACHED manual run (detachedManualRunHandler).
  // The detached route responds {accepted:true} immediately and the run
  // continues in the background, so the result the HTTP body used to
  // carry rides the channel as this final event. `result` is the fleet's
  // own run-result union (e.g. WikiLibrarianRunResult); consumers narrow
  // it. Best-effort like every broadcast - the in-flight lease is the
  // backstop if it's dropped.
  | { kind: 'result'; result: unknown }
);

/**
 * The profiles columns that hold a background-agent's manual-run
 * in-flight lease (<agent>_inflight_expires_at). A held lease (future
 * expiry) is what the UI reads to show "a run is in flight" - the
 * spinner + button-disable - for every client, including background
 * scheduled runs. Generic across fleets so the lease helpers serve the
 * wiki librarian and the memory librarians alike.
 */
export type InflightLeaseColumn =
  | 'wiki_librarian_inflight_expires_at'
  | 'memory_librarian_inflight_expires_at';

/**
 * Sentinel value the drawer's topic-filter dropdown uses to mean "rows
 * whose `topics` column is empty." It's not a real topic - the worker
 * never emits this string - but threading it through the selectedTopics
 * array lets the OR-of-checkboxes UI stay one shape (a list of strings)
 * instead of growing a second "untagged also?" boolean. The pageThreads
 * / search builders treat the sentinel specially and turn it into
 * `topics = '{}'` rather than an `&&` membership test.
 *
 * The leading "(" is illegal in any real topic (the worker prompt forbids
 * it and the agent's parse strips punctuation anyway), so the sentinel
 * can never collide with a model-emitted topic.
 */
export const UNTAGGED_TOPIC_SENTINEL = '(untagged)';

/**
 * One row of a topic-vocabulary listing: a topic name plus how many of
 * the user's items (threads / memories / recipes, depending on the RPC)
 * carry it. `count` is the number the topic dropdown shows in parens.
 */
export interface TopicCount {
  topic: string;
  count: number;
}

/**
 * Return shape of the three `list_user_*_topics` RPCs. `topics` is the
 * alphabetised real-topic vocabulary with per-topic corpus counts;
 * `untagged` is how many items have no topics at all (backs the
 * synthesised "(untagged)" dropdown row). Counts are corpus-wide on
 * purpose - the memory and thread lists are paginated/capped client-
 * side, so a client tally would undercount.
 */
export interface TopicVocabulary {
  topics: TopicCount[];
  untagged: number;
}

/**
 * One page of an offset-paginated browse listing (recipes, memories,
 * wiki articles). `hasMore` is derived from a `pageSize + 1` probe -
 * the query asks for one extra row and the method strips it, so the
 * caller learns there's a next page without a second count query.
 *
 * Why offset and not the keyset cursors the thread drawer uses
 * (ThreadCursor / ThreadPage): threads bump their `updated_at`
 * constantly under the realtime feed, so a keyset cursor is the only
 * way to page them without dropping or duplicating a row that moved
 * across the boundary mid-scroll. The cookbook / memory / wiki lists
 * are personal, low-write collections that nobody is mutating while
 * you scroll them, so offset is safe - and it pages an arbitrary
 * ORDER BY (the recipe sort picker's rating-nulls-last and
 * alphabetical modes) without the composite-cursor predicate a keyset
 * scheme would need for each sort key.
 */
export interface OffsetPage<T> {
  rows: T[];
  hasMore: boolean;
}

/** Default page size for the offset-paginated browse listings. */
export const DEFAULT_LIST_PAGE_SIZE = 50;

