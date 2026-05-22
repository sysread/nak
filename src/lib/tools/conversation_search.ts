/**
 * Search across the signed-in user's prior conversations (threads).
 *
 * Mirror of `memory_search`, but against `threads` rather than
 * `memories`. We run an exact ILIKE match on `title` in parallel with
 * a cosine-similarity vector search against `(title + summary)`
 * embeddings populated by the background summary + embed workers, then
 * merge with exact hits first. Same fallback as memory_search: if
 * Venice returns no embedding (missing key, offline), we still return
 * exact-title hits rather than an empty list.
 *
 * Why `summary` lives in the result body: the
 * `search_threads_by_embedding` RPC (shaped for the drawer UI) projects
 * only {id, title, archived, updated_at, similarity}. The LLM wants
 * summaries to judge whether a thread is worth recalling from, so we
 * round-trip back to the threads table with `listThreadSummariesByIds`
 * — one batched select keyed on the merged-hit ids, preserving merge
 * order. Cost is one extra query; the payoff is the recall agent can
 * actually tell what each thread was about without opening it.
 *
 * Current-thread filter: when the caller's ToolContext sets
 * `conversationExcludeOwnThread`, hits whose `thread.id` equals
 * `ctx.threadId` are dropped post-fetch. The flag rides on the ctx
 * (not in the LLM-visible args schema) so the model cannot toggle
 * it; the harness decides per caller. Set by the main chat-loop and
 * `ConversationRecallAgent`'s inner tool loop - both want OTHER
 * conversations, not the live one echoed back. Left unset by callers
 * that are not thread-scoped (the wiki librarian passes
 * `threadId: ''` and so doesn't need the flag - the empty id
 * matches nothing anyway).
 *
 * Schema lives in `./conversation_search.schema.ts`.
 */
import type { ToolDef } from './types';
import type { ThreadSearchHit, ThreadSummaryRow } from '../supabase';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '../models';
import {
  conversationSearchSchema,
  CONVERSATION_SEARCH_DEFAULT_LIMIT,
  CONVERSATION_SEARCH_MAX_LIMIT,
} from './conversation_search.schema';

/**
 * Result row as the LLM sees it. Flat shape (no nested `thread`
 * object) because tool results live in JSON bodies the model reads
 * token-by-token - flatter is cheaper and more scannable. `match_kind`
 * surfaces how the hit was found so the model can weigh "title
 * contained my query string" higher than "embedding was close."
 * `similarity` is only set for semantic hits.
 */
interface ConversationSearchResult {
  id: string;
  title: string;
  summary: string | null;
  updated_at: string;
  archived: boolean;
  match_kind: 'exact' | 'semantic';
  similarity?: number;
}

export const conversationSearch: ToolDef = {
  ...conversationSearchSchema,
  async execute(args, ctx): Promise<ConversationSearchResult[]> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length === 0) return [];

    const rawLimit =
      typeof args.limit === 'number'
        ? args.limit
        : CONVERSATION_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(CONVERSATION_SEARCH_MAX_LIMIT, Math.floor(rawLimit))
    );
    const excludeOwn = ctx.conversationExcludeOwnThread === true;

    let queryEmbedding: number[] | null = null;
    try {
      const response = await ctx.venice.embed({
        model: VENICE_EMBEDDING_MODEL,
        input: query,
        signal: ctx.signal,
      });
      const raw = response.data[0]?.embedding;
      if (raw && raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
    } catch {
      // Degrade silently to exact-only - better a partial result than
      // a tool error the main model interprets as "search is broken."
      queryEmbedding = null;
    }

    const hits: ThreadSearchHit[] = await ctx.supabase.searchThreads({
      query,
      queryEmbedding,
      // Fetch a bit extra so trimming the current thread doesn't push
      // us under `limit`. `searchThreads` caps its own output at the
      // limit it's given, so asking for limit+1 is enough to survive
      // a single self-exclusion.
      limit: excludeOwn ? limit + 1 : limit,
    });

    // Drop the current thread when the caller asked for own-thread
    // exclusion. Done post-fetch rather than as a DB filter because
    // `searchThreads`' contract doesn't expose an exclusion param -
    // adding one to the drawer-shared method for this one caller is
    // scope creep.
    const filtered = excludeOwn
      ? hits.filter((h) => h.thread.id !== ctx.threadId)
      : hits;
    const trimmed = filtered.slice(0, limit);
    if (trimmed.length === 0) return [];

    // Hydrate summary for every returned id. One batched select for
    // both exact and semantic hits - exact hits already carry the
    // full thread row (summary included in the server projection),
    // but the current `Thread` type doesn't surface `summary`, so
    // re-reading from a summary-aware projection keeps the tool
    // result shape uniform rather than branching on match_kind.
    const ids = trimmed.map((h) => h.thread.id);
    const summaries = await ctx.supabase.listThreadSummariesByIds(ids);
    const summaryById = new Map<string, ThreadSummaryRow>(
      summaries.map((r) => [r.id, r])
    );

    return trimmed.map((hit): ConversationSearchResult => {
      const row = summaryById.get(hit.thread.id);
      return {
        id: hit.thread.id,
        title: hit.thread.title,
        summary: row?.summary ?? null,
        updated_at: hit.thread.updated_at,
        archived: hit.thread.archived,
        match_kind: hit.kind,
        ...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}),
      };
    });
  },
};
