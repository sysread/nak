// record_search (function-side port)
//
// Cosine-similarity search over the user's wiki records (every article)
// via search_wiki_records_by_embedding. Wire schema lives in
// src/lib/tools/record_search.schema.ts. Mirrors wiki_search: embed the
// query, pad to the storage dim, hand it to the RPC. Returns [] when
// Venice is unreachable rather than throwing - a blank result beats a
// failed tool call.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { padEmbeddingForStorage } from '../../_shared/backfill.ts';
import { localEmbed } from '../../_shared/local-embed.ts';

const RECORD_SEARCH_DEFAULT_LIMIT = 10;
const RECORD_SEARCH_MAX_LIMIT = 30;

interface RecordHit {
  id: string;
  article_id: string;
  date: string;
  content: string;
  tags: unknown;
  created_at: string;
  updated_at: string;
  similarity: number;
}

export const recordSearch: ToolDef = {
  name: 'record_search',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');

    const rawLimit =
      typeof args.limit === 'number' ? args.limit : RECORD_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(RECORD_SEARCH_MAX_LIMIT, Math.floor(rawLimit)));

    let queryEmbedding: number[] | null = null;
    try {
      const raw = await localEmbed(query);
      if (raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
    } catch {
      return { records: [] };
    }
    if (!queryEmbedding) return { records: [] };

    const { data, error } = await ctx.adminClient.rpc('search_wiki_records_by_embedding', {
      query_embedding: queryEmbedding,
      match_limit: limit,
      p_user_id: ctx.userId,
    });
    if (error) throw new Error(`searchWikiRecordsByEmbedding failed: ${error.message}`);

    return {
      records: ((data ?? []) as RecordHit[]).map((r) => ({
        id: r.id,
        article_id: r.article_id,
        date: r.date,
        content: r.content,
        tags: r.tags,
        similarity: r.similarity,
      })),
    };
  },
};

registerTool(recordSearch);
