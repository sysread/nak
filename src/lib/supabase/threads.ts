/**
 * Threads domain slice of the Supabase data layer: the drawer's
 * list/paging reads (recent / older / archived plus the window fetch
 * behind search-result jumps), merged exact+semantic thread search,
 * thread CRUD, the per-thread setters (model, reasoning effort,
 * verbosity, toolboxes, archived flag, cached priming payloads), and
 * the cross-device response claims (grouped under their own banner
 * below - the claims are thread-scoped, so they live here rather than
 * in a slice of their own).
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its thread methods
 * here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types; the topic-filter
 * and ILIKE helpers shared with the memory / recipe paths live in
 * ./query-utils.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThinkingLevel, Verbosity } from '../models';
import { isValidForkPoint, pickForkPoint, type ForkPointCandidate } from '../forking';
import { SupabaseError } from './error';
import { getSession } from './session';
import { listAttachmentPagePaths } from './attachment-pages';
import {
  partitionSelectedTopics,
  topicsFilterClause,
  ilikeFilterPattern,
} from './query-utils';
import type {
  Thread,
  ThreadCursor,
  ThreadPage,
  ThreadSearchHit,
} from './types';
import { coerceThread, DEFAULT_THREAD_PAGE_SIZE } from './types';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so
 * createThread keeps its exact error behavior without reaching back
 * into SupabaseService.
 */
/**
 * One page of threads. `nextCursor === null` means the query has been
 * fully drained; any truthy value is what the caller should pass as
 * `cursor` to fetch the next page.
 */
export async function listRecentThreads(
  client: SupabaseClient,
  cutoff: string,
  selectedTopics: readonly string[] = []
): Promise<Thread[]> {
  // Everything touched within the "active" window — hardcoded by the
  // caller so the boundary doesn't drift second-to-second and flip
  // threads at the edge between Recent and Older as seconds tick by.
  // Two-column ordering mirrors listOlderThreads so a thread the
  // user just updated doesn't hop position when it transitions.
  let q = client
    .from('threads')
    .select('*')
    .eq('archived', false)
    // Hidden threads are deleted (or, post-forking, pure shared
    // structure) - no list surface shows them. Same filter on every
    // list/search read in this slice.
    .eq('hidden', false)
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(500);
  const topicsClause = topicsFilterClause(selectedTopics);
  if (topicsClause) q = q.or(topicsClause);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
}

export async function listOlderThreads(
  client: SupabaseClient,
  opts: {
    cutoff: string;
    cursor: ThreadCursor | null;
    pageSize?: number;
    selectedTopics?: readonly string[];
  }
): Promise<ThreadPage> {
  return pageThreads(client, {
    archived: false,
    cutoff: opts.cutoff,
    cursor: opts.cursor,
    pageSize: opts.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
    selectedTopics: opts.selectedTopics ?? [],
  });
}

export async function listArchivedThreads(
  client: SupabaseClient,
  opts: {
    cursor: ThreadCursor | null;
    pageSize?: number;
    selectedTopics?: readonly string[];
  }
): Promise<ThreadPage> {
  return pageThreads(client, {
    archived: true,
    cutoff: null,
    cursor: opts.cursor,
    pageSize: opts.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
    selectedTopics: opts.selectedTopics ?? [],
  });
}

/**
 * One-shot "window" fetch: every thread in `bucket` from the head of
 * the list down to (and including) `target`. Used when the user
 * clicks a search result that lives past the currently-loaded
 * pagination cursor — we need to materialise enough of the list to
 * put a DOM node at the target so `scrollIntoView` has something to
 * aim at.
 *
 * Returning rows in the same ordering the bucket uses lets the
 * caller merge without re-sorting. The archived bucket has no
 * cutoff; the older bucket only window-fetches within the "before
 * the cutoff" range (a Recent-bucket target should already be in
 * memory — recent is eager-loaded).
 */
export async function listThreadsSince(
  client: SupabaseClient,
  opts: {
    target: ThreadCursor;
    archived: boolean;
    cutoff: string | null;
    selectedTopics?: readonly string[];
  }
): Promise<Thread[]> {
  let q = client
    .from('threads')
    .select('*')
    .eq('archived', opts.archived)
    .eq('hidden', false)
    .gte('updated_at', opts.target.updated_at)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false });
  if (opts.cutoff) q = q.lt('updated_at', opts.cutoff);
  const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
  if (topicsClause) q = q.or(topicsClause);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
}

/**
 * Point read of a single thread's in-flight streaming state - the
 * server-side stream_started_at stamp plus the response-claim pair.
 * Exists for `selectThread`'s cold-start path: on a fresh page load
 * the route effect opens the URL's thread BEFORE the sidebar's thread
 * lists have fetched, so `findThread(id)` comes back empty and the
 * in-flight stamp (the signal that arms the reconnect and suppresses
 * the retry banners) was invisible exactly in the refresh-during-
 * pregame case it exists for. Returns null when the row doesn't
 * exist or RLS hides it.
 */
export async function getThreadStreamState(
  client: SupabaseClient,
  threadId: string
): Promise<{
  streamStartedAt: string | null;
  responseHolderId: string | null;
  responseClaimExpiresAt: string | null;
} | null> {
  const { data, error } = await client
    .from('threads')
    .select('stream_started_at, response_holder_id, response_claim_expires_at')
    .eq('id', threadId)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    streamStartedAt:
      typeof row.stream_started_at === 'string' ? row.stream_started_at : null,
    responseHolderId:
      typeof row.response_holder_id === 'string' ? row.response_holder_id : null,
    responseClaimExpiresAt:
      typeof row.response_claim_expires_at === 'string'
        ? row.response_claim_expires_at
        : null,
  };
}

async function pageThreads(
  client: SupabaseClient,
  opts: {
    archived: boolean;
    cutoff: string | null;
    cursor: ThreadCursor | null;
    pageSize: number;
    selectedTopics: readonly string[];
  }
): Promise<ThreadPage> {
  // Fetch pageSize+1 rows so we can derive hasMore without a second
  // count query — if the server returned pageSize+1 rows we know at
  // least one page remains, otherwise we're at the tail.
  let q = client
    .from('threads')
    .select('*')
    .eq('archived', opts.archived)
    .eq('hidden', false)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(opts.pageSize + 1);
  if (opts.cutoff) q = q.lt('updated_at', opts.cutoff);
  if (opts.cursor) {
    // Composite cursor: (updated_at, id) strictly-less-than the
    // cursor, with id tie-break. PostgREST doesn't have row-value
    // comparison sugar, so spell it as
    // `updated_at < c.updated_at OR (updated_at = c.updated_at AND id < c.id)`.
    const c = opts.cursor;
    q = q.or(
      `updated_at.lt.${c.updated_at},and(updated_at.eq.${c.updated_at},id.lt.${c.id})`
    );
  }
  const topicsClause = topicsFilterClause(opts.selectedTopics);
  if (topicsClause) q = q.or(topicsClause);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
  const hasMore = rows.length > opts.pageSize;
  const page = hasMore ? rows.slice(0, opts.pageSize) : rows;
  const last = page[page.length - 1];
  const nextCursor: ThreadCursor | null =
    hasMore && last ? { updated_at: last.updated_at, id: last.id } : null;
  return { rows: page, nextCursor };
}

/**
 * Merged exact + semantic search across all the user's threads.
 *
 * Exact hits are ILIKE matches against `title` (substring, case-
 * insensitive) — same escape pattern as `searchMemories`. Semantic
 * hits come from the `search_thread_chunks_by_embedding` RPC, which
 * ranks the transcript chunks written by the rechunk unit and keeps
 * each thread's best-matching one — so a thread can be found by what
 * was said in it, not only by the words in its title and summary.
 * Both queries run in parallel; the merge puts every exact hit
 * before every semantic hit, deduping by id on the way through so a
 * thread can't appear twice.
 *
 * `queryEmbedding` may be null — callers that couldn't produce an
 * embedding (Venice error, offline) still get useful exact-match
 * results instead of an empty list. Archived threads are included
 * in both halves; the UI greys them.
 */
export async function searchThreads(
  client: SupabaseClient,
  opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
    /**
     * When non-empty, search results are narrowed to the same topic
     * filter the drawer's date-sorted list uses. Exact (ILIKE) hits
     * are filtered server-side via the same `topicsFilterClause`
     * helper the list paths use; semantic hits come back from the
     * chunk-search RPC without topic columns, so we re-fetch the
     * matched rows and filter in memory rather than touching the RPC
     * signature.
     * Matches the "topic filter constrains search too" UX decision -
     * see docs/dev/topics.md.
     */
    selectedTopics?: readonly string[];
  }
): Promise<ThreadSearchHit[]> {
  const query = opts.query.trim();
  if (query.length === 0) return [];
  const limit = opts.limit ?? 50;
  const selectedTopics = opts.selectedTopics ?? [];
  const topicsClause = topicsFilterClause(selectedTopics);

  const pattern = ilikeFilterPattern(query);
  let exactQ = client
    .from('threads')
    .select('*')
    .eq('hidden', false)
    .ilike('title', pattern)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (topicsClause) exactQ = exactQ.or(topicsClause);
  const exactPromise = exactQ;

  // security invoker + RLS on thread_chunks means the browser client
  // needs no user filter here; p_user_id defaults to auth.uid().
  const semanticPromise = opts.queryEmbedding
    ? client.rpc('search_thread_chunks_by_embedding', {
        query_embedding: opts.queryEmbedding,
        match_limit: limit,
      })
    : Promise.resolve({ data: [] as unknown[], error: null });

  const [exactRes, semRes] = await Promise.all([exactPromise, semanticPromise]);
  if (exactRes.error) throw new SupabaseError(exactRes.error.message);
  // A semantic failure shouldn't kill the whole search — fall back to
  // exact-only. Mirrors how memory_search falls back when Venice is
  // unreachable.
  const semanticRows =
    semRes.error !== null
      ? []
      : ((semRes.data ?? []) as {
          id: string;
          title: string;
          archived: boolean;
          updated_at: string;
          similarity: number;
        }[]);

  const exactThreads = (exactRes.data ?? []).map((row) =>
    coerceThread(row as Record<string, unknown>)
  );

  // When a topic filter is active, narrow semantic hits to rows
  // matching the same predicate. The embedding RPC doesn't read
  // `topics`, so we do this client-side: fetch the matched rows'
  // topics columns by id, then drop any that don't satisfy the
  // filter. The fetch is one round trip with at most `limit` rows
  // so the overhead is small (and only paid when a filter is
  // active). When no filter is active we skip the round trip
  // entirely and the existing path runs unchanged.
  let allowedSemanticIds: Set<string> | null = null;
  if (selectedTopics.length > 0 && semanticRows.length > 0) {
    const ids = semanticRows.map((r) => r.id);
    const { topics: realTopics, includeUntagged } =
      partitionSelectedTopics(selectedTopics);
    const { data: topicRows, error: topicErr } = await client
      .from('threads')
      .select('id, topics')
      .in('id', ids);
    if (topicErr) throw new SupabaseError(topicErr.message);
    allowedSemanticIds = new Set<string>();
    const realSet = new Set(realTopics);
    for (const r of (topicRows ?? []) as { id: string; topics: unknown }[]) {
      const rowTopics = Array.isArray(r.topics)
        ? r.topics.filter((v): v is string => typeof v === 'string')
        : [];
      if (rowTopics.length === 0 && includeUntagged) {
        allowedSemanticIds.add(r.id);
        continue;
      }
      if (realSet.size > 0 && rowTopics.some((t) => realSet.has(t))) {
        allowedSemanticIds.add(r.id);
      }
    }
  }

  const out: ThreadSearchHit[] = [];
  const seen = new Set<string>();
  for (const t of exactThreads) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ thread: t, kind: 'exact' });
    if (out.length >= limit) return out;
  }
  for (const row of semanticRows) {
    if (seen.has(row.id)) continue;
    if (allowedSemanticIds && !allowedSemanticIds.has(row.id)) continue;
    seen.add(row.id);
    // The RPC projection gives us enough for the row UI; fields the
    // result list doesn't render are stubbed so downstream code that
    // wants a full Thread still gets a valid shape.
    out.push({
      thread: {
        id: row.id,
        user_id: '',
        title: row.title,
        model: null,
        reasoning_effort: null,
        verbosity: null,
        toolboxes_enabled: [],
        archived: row.archived,
        // The RPC resolves hidden-thread hits to a visible descendant
        // before returning, so every stubbed row is visible by
        // construction. Fork ancestry isn't in the RPC projection; the
        // stub reads as a root, which only costs the row its drawer
        // fork indicator while rendered from search results.
        hidden: false,
        forked_from_thread_id: null,
        forked_from_msg_id: null,
        title_manually_set: false,
        intuition_payload: null,
        context_recall_payload: null,
        topics: [],
        response_holder_id: null,
        response_claim_expires_at: null,
        stream_started_at: null,
        last_error: null,
        created_at: row.updated_at,
        updated_at: row.updated_at,
      },
      kind: 'semantic',
      similarity: row.similarity,
    });
    if (out.length >= limit) return out;
  }
  return out;
}

export async function createThread(
  client: SupabaseClient,
  title: string,
  // Model-profile id (see ModelProfile in ../models), or null to track
  // the user's default profile.
  model: string | null = null,
  reasoningEffort: ThinkingLevel | null = null,
  verbosity: Verbosity | null = null,
  titleManuallySet = false,
  toolboxesEnabled: string[] = []
): Promise<Thread> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('threads')
    .insert({
      title,
      user_id: session.user.id,
      model,
      reasoning_effort: reasoningEffort,
      verbosity,
      title_manually_set: titleManuallySet,
      // Carries the draft's toolbox selections through to the
      // persisted row. The composer toolbox button is available
      // before a draft materializes, so a user may have enabled
      // toolboxes before the first send - without this passthrough
      // those flips would silently reset to [] on materialization.
      toolboxes_enabled: toolboxesEnabled,
    })
    .select()
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceThread(data as Record<string, unknown>);
}

/**
 * Fork a conversation: mint a new thread whose transcript continues
 * from `sourceThreadId`'s history at a chosen fork point (see
 * docs/dev/forking.md). One primitive for every entry point; the
 * drawer's whole-conversation fork omits `forkMsgId` and forks at the
 * transcript tail, M5's fork-from-message passes an explicit row.
 *
 * The reparent rule is applied here: the new thread's parent is
 * whichever thread OWNS the fork-point message - for an explicit
 * `forkMsgId` that may be an ancestor of `sourceThreadId`, not the
 * source itself - which keeps "a fork point always lands in its
 * parent's own segment" structural rather than checked.
 *
 * The fork inherits the source's identity and composer settings
 * (title verbatim, title_manually_set, model / reasoning / verbosity
 * pins, enabled toolboxes) and nothing else: summary, topics, cached
 * priming payloads, archived state, and worker cursors all start
 * fresh. Null cursors are deliberate - a fresh fork's own segment is
 * empty, so per-thread worker queries never see the inherited prefix
 * and nothing double-processes (see the fork-semantics section of the
 * plan for why seeding the fork point as a cursor was rejected).
 */
export async function forkThread(
  client: SupabaseClient,
  sourceThreadId: string,
  forkMsgId?: string
): Promise<Thread> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');

  const { data: srcRow, error: srcErr } = await client
    .from('threads')
    .select('*')
    .eq('id', sourceThreadId)
    .maybeSingle();
  if (srcErr) throw new SupabaseError(srcErr.message);
  if (!srcRow) throw new SupabaseError('Conversation not found.');
  const source = coerceThread(srcRow as Record<string, unknown>);

  // Resolve the fork point and its owning thread (the parent under
  // the reparent rule).
  let pointId: string;
  let parentId: string;
  if (forkMsgId) {
    const { data: msgRow, error: msgErr } = await client
      .from('messages')
      .select('id, thread_id, role, tool_calls, status')
      .eq('id', forkMsgId)
      .maybeSingle();
    if (msgErr) throw new SupabaseError(msgErr.message);
    if (!msgRow) throw new SupabaseError('Fork point message not found.');
    const m = msgRow as {
      id: string;
      thread_id: string;
      role: string;
      tool_calls: unknown[] | null;
      status: string | null;
    };
    if (!isValidForkPoint(m)) {
      throw new SupabaseError(
        'A fork can only start at a user message or a completed assistant reply.'
      );
    }
    pointId = m.id;
    parentId = m.thread_id;
  } else {
    // Whole-conversation fork: walk the source's own-segment tail
    // back past rows a fork cannot anchor on (an in-flight streaming
    // row, a dangling tool row from an interrupted turn). Descending
    // with nullsFirst matches the "null position sorts as tail"
    // convention for rows inserted in a schema-apply window.
    const { data: tailRows, error: tailErr } = await client
      .from('messages')
      .select('id, role, tool_calls, status')
      .eq('thread_id', sourceThreadId)
      .order('position', { ascending: false, nullsFirst: true })
      .limit(50);
    if (tailErr) throw new SupabaseError(tailErr.message);
    const point = pickForkPoint((tailRows ?? []) as ForkPointCandidate[]);
    if (point) {
      pointId = point.id;
      parentId = sourceThreadId;
    } else if (source.forked_from_msg_id && source.forked_from_thread_id) {
      // The source's own segment is empty (a fork nobody has spoken
      // in yet): fork at the source's own fork point, which its
      // parent owns - the new thread becomes a sibling.
      pointId = source.forked_from_msg_id;
      parentId = source.forked_from_thread_id;
    } else {
      throw new SupabaseError('This conversation has no messages to fork yet.');
    }
  }

  const { data, error } = await client
    .from('threads')
    .insert({
      user_id: session.user.id,
      title: source.title,
      title_manually_set: source.title_manually_set,
      model: source.model,
      reasoning_effort: source.reasoning_effort,
      verbosity: source.verbosity,
      toolboxes_enabled: source.toolboxes_enabled,
      forked_from_thread_id: parentId,
      forked_from_msg_id: pointId,
    })
    .select()
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceThread(data as Record<string, unknown>);
}

/**
 * Rename a thread. The `manuallySet` flag is the signal that separates
 * the two callers:
 *
 *   - `false` (default): the `update_title` tool path. Writes the title
 *     but leaves `title_manually_set` alone — so a model-initiated
 *     rename is still considered "up for revision" on a future topic
 *     shift.
 *   - `true`: the user's title input / commitRename. Writes the title
 *     AND flips the sticky flag so the chat loop will stop feeding the
 *     rename instruction to the model. Once the user has picked a
 *     title, that choice wins permanently.
 *
 * Explicitly a single method rather than two (renameThread /
 * renameThreadManually) so there's one RPC round-trip per rename
 * regardless of path.
 */
export async function renameThread(
  client: SupabaseClient,
  threadId: string,
  title: string,
  opts: { manuallySet?: boolean } = {}
): Promise<void> {
  const patch: Record<string, unknown> = {
    title,
    updated_at: new Date().toISOString(),
  };
  if (opts.manuallySet === true) {
    patch.title_manually_set = true;
  }
  const { error } = await client
    .from('threads')
    .update(patch)
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Pin the model profile for this thread by id, or clear the override
 * (null) so the thread tracks the user's default profile.
 */
export async function setThreadModel(
  client: SupabaseClient,
  threadId: string,
  model: string | null
): Promise<void> {
  const { error } = await client
    .from('threads')
    .update({ model, updated_at: new Date().toISOString() })
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Pin the reasoning-effort level for this thread, or clear the override
 * (null) so the thread tracks the user default. Doesn't touch
 * updated_at - flipping reasoning shouldn't promote the thread to the
 * top of the sidebar, same rationale as setThreadToolboxesEnabled.
 */
export async function setThreadReasoningEffort(
  client: SupabaseClient,
  threadId: string,
  reasoningEffort: ThinkingLevel | null
): Promise<void> {
  const { error } = await client
    .from('threads')
    .update({ reasoning_effort: reasoningEffort })
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Pin the text.verbosity level for this thread, or clear the override
 * (null) so the thread tracks the user default. Same discipline as
 * setThreadReasoningEffort — no updated_at bump because flipping
 * verbosity shouldn't promote the thread to the top of the sidebar.
 */
export async function setThreadVerbosity(
  client: SupabaseClient,
  threadId: string,
  verbosity: Verbosity | null
): Promise<void> {
  const { error } = await client
    .from('threads')
    .update({ verbosity })
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Persist the cached intuition payload for this thread. Pass `null`
 * to clear (used by tests; the chat-loop only ever writes a fresh
 * payload). Doesn't bump updated_at - intuition is internal state
 * that shouldn't promote the thread to the top of the sidebar, same
 * discipline as the toolbox / verbosity / reasoning-effort setters.
 *
 * Loose typing on `payload`: the column is jsonb and the intuition
 * module owns the canonical shape (see
 * src/lib/intuition/types.ts#IntuitionPayload). Routing the parse
 * through there means a future shape change touches one file rather
 * than every Supabase call site.
 */
export async function setThreadIntuitionPayload(
  client: SupabaseClient,
  threadId: string,
  payload: unknown
): Promise<void> {
  const { error } = await client
    .from('threads')
    .update({ intuition_payload: payload })
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Persist the cached context-recall payload. Sibling of
 * setThreadIntuitionPayload and shares its discipline: no
 * updated_at bump (subconscious priming shouldn't promote the
 * thread in the sidebar), loose typing because the canonical
 * shape lives in src/lib/context-recall/types.ts.
 */
export async function setThreadContextRecallPayload(
  client: SupabaseClient,
  threadId: string,
  payload: unknown
): Promise<void> {
  const { error } = await client
    .from('threads')
    .update({ context_recall_payload: payload })
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Replace the thread's set of enabled gated toolboxes. Called from
 * the `toggle_toolbox` meta-tool (LLM path) and from the composer
 * toolbox popover (user path). The array is the new set; any
 * toolbox not listed is disabled. Doesn't touch updated_at - a
 * toolbox flip shouldn't promote the thread to the top of the
 * sidebar. Caller is responsible for pre-filtering to the known
 * toolbox names (this method writes whatever it's given - the
 * validation lives with the callers who know the valid name list).
 */
export async function setThreadToolboxesEnabled(
  client: SupabaseClient,
  threadId: string,
  enabled: readonly string[]
): Promise<void> {
  const { error } = await client
    .from('threads')
    .update({ toolboxes_enabled: enabled })
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Flip the thread's archived flag. Unlike setThreadToolboxesEnabled /
 * setThreadReasoningEffort, this one DOES bump updated_at - both
 * directions want the thread promoted to the top of whichever section
 * (Chats or Archive) it lands in, so the user immediately sees where
 * it went.
 */
export async function setThreadArchived(
  client: SupabaseClient,
  threadId: string,
  archived: boolean
): Promise<void> {
  const { error } = await client
    .from('threads')
    .update({ archived, updated_at: new Date().toISOString() })
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Delete a conversation, as the user sees it: the thread is HIDDEN,
 * not destroyed. Every list/search surface filters hidden, so it
 * vanishes instantly; the hourly fork GC destroys whatever nothing
 * visible depends on (with zero forks, the whole thread) and the
 * cascade fans out through the reference graph exactly as the old
 * direct delete did. Storage objects orphan with the cascade and the
 * daily attachment-gc reclaims them - the inline object reclamation
 * this function used to do is retired with the direct delete.
 *
 * Why deferred: once forks exist, rows of a "deleted" conversation
 * may be the shared prefix of live forks. Hide-then-GC gives every
 * delete the same semantics whether or not anything depends on it.
 */
export async function deleteThread(client: SupabaseClient, threadId: string): Promise<void> {
  const { error } = await client
    .from('threads')
    .update({ hidden: true })
    .eq('id', threadId);
  if (error) throw new SupabaseError(error.message);
}

export async function deleteMessages(
  client: SupabaseClient,
  messageIds: string[]
): Promise<void> {
  // Delete a set of message rows by id - the "delete from here"
  // gesture passes a user message and every row after it. The
  // "messages are self-deletable via thread" RLS policy scopes the
  // delete to threads the caller owns, so a forged id from another
  // user's thread silently matches nothing.
  //
  // Everything that references messages.id either cascades or clears:
  // message_attachments cascade (their bucket objects are reclaimed
  // below), and the threads.last_*_msg_id watermarks + the bias
  // evidence_message_id pointer are ON DELETE SET NULL - so the next
  // reflection/summary/topics/wiki/evaluation cycle simply re-runs
  // from a cleared watermark. samskara_substrate.user_message_id and
  // samskara_fires.user_round are soft pointers with no FK; their
  // rows survive and may go off-by-N, which the samskara design
  // accepts (rare, not worth a trigger).
  if (messageIds.length === 0) return;

  // Collect attachment object keys BEFORE the delete: the cascade
  // removes the rows, after which their bucket keys are
  // unrecoverable. Expired rows (storage_path null) have no object
  // left, so they are filtered out.
  // `id` rides along to collect the rendered-PDF page objects too (same
  // bucket, separate table, same about-to-cascade problem).
  const { data: attachRows, error: listErr } = await client
    .from('message_attachments')
    .select('id, storage_path')
    .in('message_id', messageIds)
    .not('storage_path', 'is', null);
  if (listErr) throw new SupabaseError(listErr.message);
  const paths = (attachRows ?? [])
    .map((r) => (r as { storage_path: string | null }).storage_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  paths.push(
    ...(await listAttachmentPagePaths(
      client,
      (attachRows ?? []).map((r) => (r as { id: string }).id)
    ))
  );

  const { error } = await client.from('messages').delete().in('id', messageIds);
  if (error) throw new SupabaseError(error.message);

  // Best-effort object reclamation AFTER the rows are gone (same order
  // as deleteThread): a Storage hiccup must not strand a live row
  // pointing at a deleted object. Anything left behind is swept by the
  // daily attachment-gc (bucket objects with no message_attachments
  // row), so the remove error is swallowed rather than failing the
  // delete.
  if (paths.length > 0) {
    await client.storage.from('attachments').remove(paths);
  }
}

// Thread response claims -----------------------------------------------
//
// The cross-device "responding here" claim: one device at a time may
// generate the assistant turn for a thread. All three calls are thin
// wrappers over SQL functions that own the atomicity (see
// supabase/schema.sql); thread-scoped, hence grouped with the thread
// slice rather than a module of their own.

/**
 * Try to take the response claim on `threadId`. Returns true iff we
 * hold it after the call. Atomic: the underlying SQL update only
 * lands if the thread is unclaimed, ours already (harmless refresh),
 * or carrying an expired claim. A `false` return means another
 * device beat us to the claim and still owns a live TTL window.
 */
export async function acquireThreadResponseClaim(
  client: SupabaseClient,
  threadId: string,
  holderId: string,
  ttlSeconds: number
): Promise<boolean> {
  const { data, error } = await client.rpc('acquire_thread_response_claim', {
    p_thread_id: threadId,
    p_holder_id: holderId,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new SupabaseError(error.message);
  return data === true;
}

/**
 * Extend our claim on `threadId`. Returns false when the claim has
 * already lapsed or been taken over - the chat-loop must abort
 * immediately in that case to avoid a double-response race with the
 * new holder.
 */
export async function heartbeatThreadResponseClaim(
  client: SupabaseClient,
  threadId: string,
  holderId: string,
  ttlSeconds: number
): Promise<boolean> {
  const { data, error } = await client.rpc('heartbeat_thread_response_claim', {
    p_thread_id: threadId,
    p_holder_id: holderId,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new SupabaseError(error.message);
  return data === true;
}

/**
 * Release the claim on `threadId` explicitly on graceful end-of-turn
 * (success, abort, error). Lets observer devices re-enable their
 * composer instantly rather than waiting for the TTL to elapse.
 * No-op when we don't actually hold the claim.
 */
export async function releaseThreadResponseClaim(
  client: SupabaseClient,
  threadId: string,
  holderId: string
): Promise<void> {
  const { error } = await client.rpc('release_thread_response_claim', {
    p_thread_id: threadId,
    p_holder_id: holderId,
  });
  if (error) throw new SupabaseError(error.message);
}
