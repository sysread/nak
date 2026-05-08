/**
 * Semantic + substring search over the user's journal entries. Same
 * shape as memory_search: embed the query via Venice, run a vector
 * cosine search against the stored embedding column, and merge with
 * an ILIKE fallback so unembedded rows (freshly-written, not yet
 * touched by the embeddings worker) still participate.
 *
 * Ships `similarity` when the vector RPC produced it so the LLM can
 * reason about how confident each match is. Substring-only hits have
 * no similarity field.
 */
import type { ToolDef } from './types';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '../models';
import {
  journalSearchSchema,
  JOURNAL_SEARCH_DEFAULT_LIMIT,
  JOURNAL_SEARCH_MAX_LIMIT,
} from './journal_search.schema';

export const journalSearch: ToolDef = {
  ...journalSearchSchema,
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');
    const rawLimit =
      typeof args.limit === 'number'
        ? args.limit
        : JOURNAL_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(JOURNAL_SEARCH_MAX_LIMIT, Math.floor(rawLimit))
    );

    // Embed the query. Silent fallback to ILIKE-only on failure,
    // matching memory_search's discipline - the model would rather
    // see substring hits than a hard error.
    let queryEmbedding: number[] | null = null;
    try {
      const response = await ctx.venice.embed({
        model: VENICE_EMBEDDING_MODEL,
        input: query,
        signal: ctx.signal,
      });
      const raw = response.data[0]?.embedding;
      if (raw && raw.length > 0) {
        queryEmbedding = padEmbeddingForStorage(raw);
      }
    } catch {
      queryEmbedding = null;
    }

    const rows = await ctx.supabase.searchJournalEntries({
      query,
      queryEmbedding,
      limit,
    });
    return rows.map((e) => ({
      id: e.id,
      entry_date: e.entry_date,
      source: e.source,
      content: e.content,
      topics: e.topics,
      mood: e.mood,
      people: e.people,
      updated_at: e.updated_at,
      ...(typeof e.similarity === 'number' ? { similarity: e.similarity } : {}),
    }));
  },
};
