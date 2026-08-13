// conversation_search (function-side port)
//
// Cosine-similarity search over the user's prior threads, hydrated
// with summaries so the model can judge each hit without opening it.
// Wire schema lives in src/lib/tools/conversation_search.schema.ts.
//
// Ranks over TRANSCRIPT CHUNKS. The thread once carried a single vector
// built from 2000 chars of title + summary, which meant the words a user
// typed were never in the index: a thread auto-titled "Bread Recipe
// Modification Advice" could not be found by searching "lentils" despite
// that word opening its first message. Chunks carry the matching passage
// back with them so a caller can jump straight to it
// (conversation_get's `query`).
//
// A thread is unrankable here until the rechunk unit has reached it
// (`threads.last_chunked_msg_id` null). That window is normally minutes
// - the unit runs on every chat turn's tail - and title ILIKE covers it
// in the callers that have an exact arm.
//
// Simplifications vs the browser path: the browser merges ILIKE-on-
// title hits with vector hits ("exact before semantic"); this port
// runs vector-only. The "exclude own thread" filter (browser flag
// ctx.conversationExcludeOwnThread, set by main chat-loop and the
// recall agent) is applied post-fetch using ctx.threadId, since the
// model never sets it via args.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { padEmbeddingForStorage, VENICE_EMBEDDING_MODEL } from '../../_shared/backfill.ts';
import { veniceEmbed } from '../../_shared/venice.ts';
import { readVeniceKey } from './_venice_key.ts';

const CONVERSATION_SEARCH_DEFAULT_LIMIT = 10;
const CONVERSATION_SEARCH_MAX_LIMIT = 50;
const CONVERSATION_SEARCH_MAX_WITHIN_DAYS = 1825;

/**
 * Additive recency nudge for `prefer_recent`, decaying with a 7-day
 * constant (see the RPC). Sized against the live corpus rather than
 * picked: measured over 478 threads, the top-10 similarity band spans
 * about 0.04, and rank displacement behaves like this -
 *
 *   +0.03  1 new thread in the top 10, best topical match still first
 *   +0.05  2 new threads,              best topical match still first
 *   +0.10  4 new threads,              #1 becomes a thread ranked 14th
 *          on relevance
 *   +0.20  9 of 10 results are new - effectively "recent threads"
 *
 * 0.05 is the last value that reorders the tail without letting recency
 * outvote topic. Note how small it has to be: a MULTIPLICATIVE boost of
 * even 1.5x adds ~0.30 to a typical score, six times past this and three
 * times past the point where the ranking stops being about the query.
 * That is why this knob is additive and why it is capped here rather
 * than exposed to the model.
 */
const CONVERSATION_SEARCH_RECENCY_BOOST = 0.05;

/** A chunk hit: a thread projection plus the passage that matched. */
interface ChunkEmbeddingHit {
  id: string;
  title: string;
  archived: boolean;
  updated_at: string;
  similarity: number;
  chunk_index: number;
  start_msg_id: string | null;
  end_msg_id: string | null;
  excerpt: string;
}

export const conversationSearch: ToolDef = {
  name: 'conversation_search',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    // Error, not an empty result: every wire schema marks query required,
    // and a silent [] reads as "no matches" when the real problem is a
    // dropped argument.
    if (query.length === 0) throw new Error('query is required');

    const rawLimit =
      typeof args.limit === 'number' ? args.limit : CONVERSATION_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(CONVERSATION_SEARCH_MAX_LIMIT, Math.floor(rawLimit)),
    );

    const withinDays =
      typeof args.within_days === 'number' && Number.isFinite(args.within_days)
        ? Math.max(
            1,
            Math.min(CONVERSATION_SEARCH_MAX_WITHIN_DAYS, Math.floor(args.within_days)),
          )
        : null;
    const preferRecent = args.prefer_recent === true;

    // Fetch limit + 1 so a post-fetch self-exclusion doesn't push
    // results under the asked-for count.
    const fetchLimit = limit + 1;

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) return [];

    let queryEmbedding: number[] | null = null;
    try {
      const resp = await veniceEmbed({
        apiKey,
        model: VENICE_EMBEDDING_MODEL,
        input: query,
      });
      const raw = resp.data[0]?.embedding;
      if (raw && raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
    } catch {
      return [];
    }
    if (!queryEmbedding) return [];

    const { data, error } = await ctx.adminClient.rpc(
      'search_thread_chunks_by_embedding',
      {
        query_embedding: queryEmbedding,
        match_limit: fetchLimit,
        p_user_id: ctx.userId,
        p_updated_after: withinDays === null
          ? null
          : new Date(Date.now() - withinDays * 86_400_000).toISOString(),
        p_recency_boost: preferRecent ? CONVERSATION_SEARCH_RECENCY_BOOST : 0,
      },
    );
    if (error) {
      throw new Error(`searchThreadChunksByEmbedding failed: ${error.message}`);
    }

    // Exclude the current thread from main-chat results; the live
    // conversation echoed back as "recall context" is noise. Same
    // discipline as the browser path's conversationExcludeOwnThread,
    // applied unconditionally here because main chat is the only
    // currently-active caller post-cut.
    const hits = ((data ?? []) as ChunkEmbeddingHit[])
      // Null threadId (a cross-thread librarian run) simply excludes
      // nothing - there is no current conversation to echo back.
      .filter((h) => h.id !== ctx.threadId)
      .slice(0, limit);
    if (hits.length === 0) return [];

    // Hydrate summary in one batched select keyed on the hit ids.
    // The RPC's projection drops `summary` because the drawer doesn't
    // render it; here we want it for the model.
    const ids = hits.map((h) => h.id);
    // RLS OFF: filter by userId. user_id eq + in() over the hit ids
    // protects against a malformed hit row referencing another
    // user's thread (defense in depth - the RPC already filtered).
    const { data: rows, error: rowsErr } = await ctx.adminClient
      .from('threads')
      .select('id, title, summary, archived, updated_at')
      .eq('user_id', ctx.userId)
      .in('id', ids);
    if (rowsErr) throw new Error(`listThreadSummariesByIds failed: ${rowsErr.message}`);

    const byId = new Map<string, { summary: string | null }>();
    for (const row of (rows ?? []) as { id: string; summary: string | null }[]) {
      byId.set(row.id, { summary: row.summary });
    }

    return hits.map((h) => ({
      id: h.id,
      title: h.title,
      summary: byId.get(h.id)?.summary ?? null,
      updated_at: h.updated_at,
      archived: h.archived,
      match_kind: 'semantic' as const,
      similarity: h.similarity,
      // The excerpt that actually matched. This is what tells the model
      // the hit is about something IN the thread rather than about its
      // title, and gives conversation_get a query to re-find it with -
      // the failure this whole feature exists to fix was a model that
      // found the right thread and then could not locate the passage
      // inside it.
      passage: h.excerpt,
    }));
  },
};

registerTool(conversationSearch);
