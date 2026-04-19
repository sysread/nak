/**
 * Find existing memories by a query. With `query` non-empty we run a
 * cosine-similarity search against the pgvector column; with `query`
 * empty we list everything most-recent-first (same as before).
 *
 * The tool surface is unchanged by design — the LLM can't tell vector
 * search apart from ILIKE, and keeping the parameters identical means
 * the rest of the chat plumbing (system-prompt catalog, tool registry,
 * threaded state) didn't move.
 *
 * Why the ILIKE fallback: embeddings are populated by a background
 * worker that polls every ~30s. A memory the user just wrote is
 * `embedding is null` until the worker catches up, so a pure vector
 * search would hide it. We always run the ILIKE path against
 * unembedded rows and merge results in — vector hits first, then any
 * ILIKE hits the vector search missed. The merged set is deduped and
 * capped at `limit`.
 */
import type { ToolDef } from './types';
import type { Memory } from '../supabase';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '../models';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const memorySearch: ToolDef = {
  name: 'memory_search',
  description:
    "Search the user's saved memories by meaning. Returns an array of " +
    '{id, label, data, updated_at}. Leave `query` empty to list every ' +
    'memory. Use this before memory_update / memory_delete to find the ' +
    'id of the memory you want to target.',
  shortDescription: "search the user's saved notes",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language query. Semantic (embedding) match — paraphrases ' +
          'and synonyms work, not just substrings. Empty or omitted returns ' +
          'all memories.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));

    // Empty query: unchanged behavior — list-all ordered by freshness.
    if (query.length === 0) return ctx.supabase.searchMemories('', limit);

    // Vector search path. Embed the query using the same model the
    // worker writes with, then zero-pad to the column's storage dim —
    // the RPC parameter is `vector(EMBEDDING_STORAGE_DIMS)` and pgvector
    // rejects a mismatched-dim literal at the parser level, not with a
    // useful error. Padding is cosine-invariant (the zero suffix
    // contributes nothing to the dot product).
    const response = await ctx.venice.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: query,
      signal: ctx.signal,
    });
    const rawEmbedding = response.data[0]?.embedding;
    // Belt-and-suspenders: if Venice returns a zero-length data array
    // (it shouldn't per spec) fall back to the legacy ILIKE path
    // rather than throwing. The LLM gets results; we get a console
    // breadcrumb.
    if (!rawEmbedding || rawEmbedding.length === 0) {
      return ctx.supabase.searchMemories(query, limit);
    }
    const queryEmbedding = padEmbeddingForStorage(rawEmbedding);

    // Run the RPC and the unembedded-ILIKE probe in parallel — they
    // hit disjoint row sets (RPC filters `embedding is not null`,
    // ILIKE path filters `embedding is null`), so merging is a straight
    // concat with ordering by "vector first, then recency".
    const [vectorHits, ilikeHits] = await Promise.all([
      ctx.supabase.searchMemoriesByEmbedding(queryEmbedding, limit),
      ctx.supabase.searchUnembeddedMemoriesByText(query, limit),
    ]);

    const seen = new Set<string>();
    const merged: Memory[] = [];
    for (const row of vectorHits) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
      if (merged.length >= limit) return merged;
    }
    for (const row of ilikeHits) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
      if (merged.length >= limit) return merged;
    }
    return merged;
  },
};
