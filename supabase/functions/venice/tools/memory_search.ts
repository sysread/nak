// memory_search (function-side port)
//
// Cosine-similarity search over the user's memories with an ILIKE
// fallback when the query is empty or when Venice can't embed.
// Hydrates outbound relations for each hit in one batched RPC so the
// model sees the graph alongside results. Wire schema lives in
// src/lib/tools/memory_search.schema.ts.
//
// Auth: b-strict. Calls search_memories_by_embedding /
// get_memory_relations / listMemoryRelationsFor with the p_user_id
// escape hatch (added to those RPCs alongside this port - see
// schema.sql), and the ILIKE / list-all paths add an explicit
// user_id filter directly.
//
// What we skip vs the browser path: the recordRecalledMemoryIds
// callback (browser-only bookkeeping for the rem librarian's hint
// queue; the recall agent path will re-add it when that family
// ports).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { padEmbeddingForStorage } from '../../_shared/backfill.ts';
import { localEmbed } from '../../_shared/local-embed.ts';

const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
const MEMORY_SEARCH_MAX_LIMIT = 50;
// Mirror of SEARCH_RELATION_FANOUT in src/lib/tools/memory_search.ts.
const SEARCH_RELATION_FANOUT = 5;

interface MemoryRow {
  id: string;
  label: string;
  data: string;
  confidence: number | null;
  topics: string[] | null;
  updated_at: string;
}

interface MemoryRelationRow {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  kind: string;
  note: string | null;
  to_label: string;
  to_data: string;
  to_confidence: number | null;
}

// Mirror of classifyMemoryConfidence in src/lib/memories.ts: the
// [1.5, 5.0) band is deliberately untagged (neutral) so ordinary
// memories read as plain facts, and anything below 0.5 is 'shaky'
// all the way down. An earlier version of this mirror drifted from
// the browser bands (it tagged the neutral band 'hedged'); keep the
// two in lockstep when either changes. Exported for the memory
// librarians' batch renderers, which prefix each row with its tag.
export function classifyMemoryConfidence(confidence: number | null): string | null {
  if (confidence === null || !Number.isFinite(confidence)) return null;
  if (confidence >= 5.0) return 'corroborated';
  if (confidence >= 1.5) return null;
  if (confidence >= 0.5) return 'hedged';
  return 'shaky';
}

// ILIKE pattern helper. Same shape as src/lib/supabase.ts
// ilikeFilterPattern: escape metacharacters, wrap with %...%.
function ilikeFilterPattern(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export const memorySearch: ToolDef = {
  name: 'memory_search',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : MEMORY_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(MEMORY_SEARCH_MAX_LIMIT, Math.floor(rawLimit)),
    );

    const memories: MemoryRow[] = await searchMemories(ctx, query, limit);

    // Hydrate outbound edges in one batched RPC. Errors degrade
    // silently to no-edges - the search result is still useful
    // without the graph layer.
    const relationsByFrom = new Map<string, MemoryRelationRow[]>();
    if (memories.length > 0) {
      try {
        const ids = memories.map((m) => m.id);
        const { data, error } = await ctx.adminClient.rpc('get_memory_relations', {
          p_ids: ids,
          p_user_id: ctx.userId,
        });
        if (!error && Array.isArray(data)) {
          for (const edge of data as MemoryRelationRow[]) {
            const list = relationsByFrom.get(edge.from_memory_id);
            if (list) list.push(edge);
            else relationsByFrom.set(edge.from_memory_id, [edge]);
          }
        }
      } catch {
        // swallow - see above
      }
    }

    return memories.map((m) => {
      const tag = classifyMemoryConfidence(m.confidence);
      const edges = (relationsByFrom.get(m.id) ?? []).slice(0, SEARCH_RELATION_FANOUT);
      return {
        id: m.id,
        label: m.label,
        data: m.data,
        confidence: m.confidence,
        confidence_tag: tag,
        updated_at: m.updated_at,
        relations: edges.map((e) => ({
          id: e.id,
          kind: e.kind,
          note: e.note,
          target: {
            id: e.to_memory_id,
            label: e.to_label,
            data: e.to_data,
            confidence: e.to_confidence,
            confidence_tag: classifyMemoryConfidence(e.to_confidence),
          },
        })),
      };
    });
  },
};

// Search dispatch with embed -> RPC -> ILIKE fallback. Mirrors the
// browser's searchMemoriesSemantic shape.
async function searchMemories(
  ctx: ToolContext,
  query: string,
  limit: number,
): Promise<MemoryRow[]> {
  // Empty query: list-all most-recent-first. // RLS OFF: explicit
  // user_id filter on memories.
  if (query.length === 0) {
    const { data, error } = await ctx.adminClient
      .from('memories')
      .select('id, label, data, confidence, topics, updated_at')
      .eq('user_id', ctx.userId)
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`searchMemories (list-all) failed: ${error.message}`);
    return (data ?? []) as MemoryRow[];
  }

  // Try embed. On any failure, fall back to ILIKE so the user still
  // gets substring matches without a hard error.
  let rawEmbedding: number[] | undefined;
  try {
    rawEmbedding = await localEmbed(query);
  } catch {
    return ilikeMemories(ctx, query, limit);
  }
  if (!rawEmbedding || rawEmbedding.length === 0) {
    return ilikeMemories(ctx, query, limit);
  }

  // Vector path: pad to storage dim, call the search RPC with the
  // p_user_id escape hatch.
  const queryEmbedding = padEmbeddingForStorage(rawEmbedding);
  const { data, error } = await ctx.adminClient.rpc('search_memories_by_embedding', {
    query_embedding: queryEmbedding,
    match_limit: limit,
    p_user_id: ctx.userId,
  });
  if (error) {
    // RPC failure also falls back to ILIKE rather than hard error.
    return ilikeMemories(ctx, query, limit);
  }
  return (data ?? []) as MemoryRow[];
}

// ILIKE substring search on label + data. Browser path runs this in
// parallel with the vector search and merges; for the function-side
// port, we use it only as a fallback - simplifies the wire shape and
// the embed path is the common case.
async function ilikeMemories(
  ctx: ToolContext,
  query: string,
  limit: number,
): Promise<MemoryRow[]> {
  const pattern = ilikeFilterPattern(query);
  // RLS OFF: explicit user_id filter on memories.
  const { data, error } = await ctx.adminClient
    .from('memories')
    .select('id, label, data, confidence, topics, updated_at')
    .eq('user_id', ctx.userId)
    .or(`label.ilike.${pattern},data.ilike.${pattern}`)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`searchMemories (ilike) failed: ${error.message}`);
  return (data ?? []) as MemoryRow[];
}

registerTool(memorySearch);
