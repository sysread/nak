// conversation_search (function-side port)
//
// Cosine-similarity search over the user's prior threads, hydrated
// with summaries so the model can judge each hit without opening it.
// Wire schema lives in src/lib/tools/conversation_search.schema.ts.
//
// Ranks over TRANSCRIPT CHUNKS, not just title+summary. The thread-level
// vector covers 2000 chars of title+summary (see _shared/embed-input.ts),
// which meant the words a user typed were never in the index: a thread
// auto-titled "Bread Recipe Modification Advice" could not be found by
// searching "lentils" despite that word opening its first message. Chunk
// hits carry the matching passage back with them so a caller can jump
// straight to it (conversation_get's `query`).
//
// Both indexes are queried and merged, keeping the better score per
// thread. That is not belt-and-braces - it is the migration path. A
// thread has no chunk rows until the rechunk unit reaches it, so
// chunk-only search would blind the tool to most of the corpus until
// that backfill drains. Keep the merge until every thread carries
// chunks; deleting it early silently narrows recall to recent threads.
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

interface ThreadEmbeddingHit {
  id: string;
  title: string;
  archived: boolean;
  updated_at: string;
  similarity: number;
}

/** A chunk hit: a thread projection plus the passage that matched. */
interface ChunkEmbeddingHit extends ThreadEmbeddingHit {
  chunk_index: number;
  start_msg_id: string | null;
  end_msg_id: string | null;
  excerpt: string;
}

/**
 * Merge chunk hits and thread-level hits into one ranked list, one row
 * per thread, keeping whichever index scored the thread higher.
 *
 * The two scores are comparable because both are cosine similarity
 * against the same query vector from the same model - what differs is
 * the text each was built over, not the metric.
 *
 * Chunk hits win ties on purpose: an equal score from a passage is more
 * useful than one from a summary, because only the passage can tell the
 * caller WHERE in the thread to look.
 */
function mergeHits(
  chunkHits: readonly ChunkEmbeddingHit[],
  threadHits: readonly ThreadEmbeddingHit[],
): (ThreadEmbeddingHit & Partial<ChunkEmbeddingHit>)[] {
  const byId = new Map<string, ThreadEmbeddingHit & Partial<ChunkEmbeddingHit>>();
  for (const hit of chunkHits) byId.set(hit.id, hit);
  for (const hit of threadHits) {
    const existing = byId.get(hit.id);
    if (!existing) {
      byId.set(hit.id, hit);
    } else if (hit.similarity > existing.similarity) {
      // Keep the passage anchors even when the summary scored higher -
      // the caller still wants somewhere to land in the transcript.
      byId.set(hit.id, { ...existing, similarity: hit.similarity });
    }
  }
  return [...byId.values()].sort((a, b) => b.similarity - a.similarity);
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

    const [chunkResult, threadResult] = await Promise.all([
      ctx.adminClient.rpc('search_thread_chunks_by_embedding', {
        query_embedding: queryEmbedding,
        match_limit: fetchLimit,
        p_user_id: ctx.userId,
      }),
      ctx.adminClient.rpc('search_threads_by_embedding', {
        query_embedding: queryEmbedding,
        match_limit: fetchLimit,
        p_user_id: ctx.userId,
      }),
    ]);
    if (threadResult.error) {
      throw new Error(`searchThreadsByEmbedding failed: ${threadResult.error.message}`);
    }
    // A chunk-index failure degrades to title+summary results rather
    // than failing the whole search - the thread index is the one that
    // has always existed, so it is the safe floor.
    const chunkHits = chunkResult.error
      ? []
      : ((chunkResult.data ?? []) as ChunkEmbeddingHit[]);

    // Exclude the current thread from main-chat results; the live
    // conversation echoed back as "recall context" is noise. Same
    // discipline as the browser path's conversationExcludeOwnThread,
    // applied unconditionally here because main chat is the only
    // currently-active caller post-cut.
    const hits = mergeHits(chunkHits, (threadResult.data ?? []) as ThreadEmbeddingHit[])
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
      // Present only on threads the chunk index reached. `passage` is
      // what tells the model the hit is about something IN the thread
      // rather than about its title, and gives conversation_get a query
      // to re-find it with - the failure this whole feature exists to
      // fix was a model that found the right thread and then could not
      // locate the passage inside it.
      passage: h.excerpt ?? null,
    }));
  },
};

registerTool(conversationSearch);
