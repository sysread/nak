// conversation_search (function-side port)
//
// Cosine-similarity search over the user's prior threads, hydrated
// with summaries so the model can judge each hit without opening it.
// Wire schema lives in src/lib/tools/conversation_search.schema.ts.
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

export const conversationSearch: ToolDef = {
  name: 'conversation_search',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length === 0) return [];

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

    const { data, error } = await ctx.adminClient.rpc('search_threads_by_embedding', {
      query_embedding: queryEmbedding,
      match_limit: fetchLimit,
      p_user_id: ctx.userId,
    });
    if (error) throw new Error(`searchThreadsByEmbedding failed: ${error.message}`);

    // Exclude the current thread from main-chat results; the live
    // conversation echoed back as "recall context" is noise. Same
    // discipline as the browser path's conversationExcludeOwnThread,
    // applied unconditionally here because main chat is the only
    // currently-active caller post-cut.
    const hits = ((data ?? []) as ThreadEmbeddingHit[])
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
    }));
  },
};

registerTool(conversationSearch);
