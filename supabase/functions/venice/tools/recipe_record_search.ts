// recipe_record_search (function-side port)
//
// Cosine-similarity search over the user's cooking records (every
// recipe), merged with an ILIKE pass on the record bodies - the
// browser merge's shape (searchRecipeRecords in
// src/lib/supabase/recipe-records.ts): semantic hits first, then ILIKE
// hits the vector path missed, deduped by id, capped at limit.
//
// DIVERGENCE from the wiki twin (record_search.ts), deliberate: the
// twin is semantic-RPC only and returns [] when the embedder is down;
// this tool degrades to ILIKE-only so the search stays useful with the
// embedder down. An empty query throws here (matching the twin); the
// empty-query short-circuit to a recent-first listing lives in the
// data-layer merge the UI search box uses.
//
// recipe_id scope and the outcome filter reach BOTH legs: the search
// RPC takes p_recipe_id / p_outcome and filters inside the RPC, before
// the limit (post-filtering a capped result would mangle the counts),
// and the ILIKE leg applies the same filters as standalone .eq()s.
//
// Auth: b-strict. The ILIKE leg is a STANDALONE .ilike() filter, so
// its pattern must come from the plain %query% builder below - NOT the
// double-quoted logic-tree builder (ilikeLogicTreePattern in
// src/lib/supabase/query-utils.ts). PostgREST strips surrounding
// quotes only inside a logic tree, so the quoted pattern hunts for
// literal quote characters and the leg is effectively dead - the wiki
// twin's data layer had exactly that bug. The leg also carries an
// explicit .eq('user_id', ctx.userId) guard (the RPC leg carries
// p_user_id for the same reason).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { padEmbeddingForStorage } from '../../_shared/backfill.ts';
import { localEmbed } from '../../_shared/local-embed.ts';
import {
  RECIPE_RECORD_COLUMNS,
  isRecipeRecordOutcome,
} from './_recipe_record_helpers.ts';

const RECIPE_RECORD_SEARCH_DEFAULT_LIMIT = 10;
const RECIPE_RECORD_SEARCH_MAX_LIMIT = 30;

// ILIKE pattern helper for a standalone .ilike() filter. Mirrors the
// file-local helper in recipe_list.ts: escape ILIKE metacharacters in
// the user input, then wrap in %...%. Do NOT swap in the double-quoted
// logic-tree builder here - see the file preamble for why the quotes
// would kill this leg.
function ilikeFilterPattern(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

interface RecordHit {
  id: string;
  recipe_id: string;
  date: string;
  content: string;
  tags: unknown;
  outcome: string | null;
  similarity: number | null;
}

// The ILIKE leg's select (RECIPE_RECORD_COLUMNS) returns the record
// columns only - similarity comes from the RPC leg alone.
type IlikeRow = Omit<RecordHit, 'similarity'>;

export const recipeRecordSearch: ToolDef = {
  name: 'recipe_record_search',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');
    const recipeId =
      typeof args.recipe_id === 'string' && args.recipe_id.trim().length > 0
        ? args.recipe_id.trim()
        : null;
    const outcome = isRecipeRecordOutcome(args.outcome) ? args.outcome : null;
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : RECIPE_RECORD_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(RECIPE_RECORD_SEARCH_MAX_LIMIT, Math.floor(rawLimit)),
    );

    // Embed the query. Embedder failure degrades to ILIKE-only rather
    // than returning empty - the deliberate divergence from the wiki
    // twin named in the preamble.
    let queryEmbedding: number[] | null = null;
    try {
      const raw = await localEmbed(query);
      if (raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
    } catch {
      queryEmbedding = null;
    }

    // ILIKE leg. RLS OFF: explicit user_id filter on recipe_records.
    let ilikeQuery = ctx.adminClient
      .from('recipe_records')
      .select(RECIPE_RECORD_COLUMNS)
      .eq('user_id', ctx.userId);
    if (recipeId) ilikeQuery = ilikeQuery.eq('recipe_id', recipeId);
    if (outcome) ilikeQuery = ilikeQuery.eq('outcome', outcome);
    const ilikePromise = ilikeQuery
      .ilike('content', ilikeFilterPattern(query))
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);

    // Semantic leg: the RPC filters recipe_id + outcome internally,
    // before the limit.
    const semanticPromise = queryEmbedding
      ? ctx.adminClient.rpc('search_recipe_records_by_embedding', {
          query_embedding: queryEmbedding,
          match_limit: limit,
          p_user_id: ctx.userId,
          p_recipe_id: recipeId,
          p_outcome: outcome,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) {
      throw new Error(`searchRecipeRecords (ilike) failed: ${ilikeRes.error.message}`);
    }
    // An RPC failure still yields the ILIKE hits - same degradation
    // posture as the embedder being down.
    const semanticRows = semRes.error ? [] : ((semRes.data ?? []) as RecordHit[]);
    // The ILIKE select carries no similarity column.
    const ilikeRows = ((ilikeRes.data ?? []) as IlikeRow[]).map((r) => ({
      ...r,
      // ILIKE rows carry no similarity; null keeps the field present
      // so the payload shape is stable across hits.
      similarity: null,
    }));

    // Merge: semantic first, then ILIKE hits the vector path missed,
    // deduped by id, capped at limit (the browser merge's shape).
    const out: RecordHit[] = [];
    const seen = new Set<string>();
    for (const hit of [...semanticRows, ...ilikeRows]) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      out.push(hit);
      if (out.length >= limit) break;
    }
    return {
      records: out.map((r) => ({
        id: r.id,
        recipe_id: r.recipe_id,
        date: r.date,
        content: r.content,
        tags: r.tags,
        outcome: r.outcome,
        similarity: r.similarity,
      })),
    };
  },
};

registerTool(recipeRecordSearch);
