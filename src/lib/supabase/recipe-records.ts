/**
 * Recipe-records domain slice of the Supabase data layer: dated entries
 * in a recipe's cooking log. The recipe's cooklang owns the distilled
 * "current state"; a record is one dated event - an iteration, an
 * observation, an outcome, an idea. This module covers record CRUD +
 * filtered listing + the two legs of the cross-recipe search merge +
 * the two support queries the Cookbook UI needs (a head count for the
 * delete confirmation, a batched title lookup for cross-recipe
 * search-hit labels). Deliberately no wiki_changelog analog: records
 * are themselves the diary (plan decision 2), and a record write never
 * touches the parent recipe row, so no recipe surface has anything to
 * audit.
 *
 * RLS owner-scopes every query; the `recipe_records` table cascades on
 * recipe delete. updated_at is stamped by a DB trigger, not here.
 * Inserts set user_id explicitly (RLS checks with_check against the
 * row, and there's no default).
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its recipe-record
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and the coercer live in ./types/cookbook; the
 * embed-the-query wrapper that feeds searchRecipeRecords lives in
 * ../recipe-records-search.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { getSession } from './session';
import { ilikeFilterPattern } from './query-utils';
import type { RecipeRecord } from './types';
import { coerceRecipeRecord } from './types';

// Every read path projects the same column set (no per-path embeds or
// aggregations, unlike the wiki twin's attachment-count embed), so one
// string serves list / get / create / update / both search legs.
const RECORD_COLUMNS =
  'id, user_id, recipe_id, date, content, tags, outcome, source_conversation_id, created_at, updated_at';

/**
 * List one recipe's log, reverse-chronological by event date.
 * Optional date-range (inclusive), tag, and outcome filters. Tags use
 * JSONB containment (`tags @> [...]`) so a row must carry every
 * requested tag (AND semantics) - the GIN index on `tags` backs this.
 * Outcome is a plain equality (the check constraint bounds the values)
 * and exists because browse-mode outcome filtering is a promised
 * surface, not just a search param.
 */
export async function listRecipeRecords(
  client: SupabaseClient,
  recipeId: string,
  filters: {
    fromDate?: string;
    toDate?: string;
    tags?: string[];
    outcome?: string | null;
    limit?: number;
  } = {}
): Promise<RecipeRecord[]> {
  let query = client
    .from('recipe_records')
    .select(RECORD_COLUMNS)
    .eq('recipe_id', recipeId)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });
  if (filters.fromDate) query = query.gte('date', filters.fromDate);
  if (filters.toDate) query = query.lte('date', filters.toDate);
  // JSON.stringify is load-bearing: `tags` is jsonb, and supabase-js
  // serializes a raw JS array as a Postgres array literal (`cs.{a,b}`),
  // which PostgREST rejects against jsonb with a 400 (22P02). The
  // stringified form is the JSON-array containment `cs.["a","b"]` the
  // column needs. Found by the QA use-case's first run - the wiki twin
  // shipped the same bug.
  if (filters.tags && filters.tags.length > 0)
    query = query.contains('tags', JSON.stringify(filters.tags));
  if (filters.outcome) query = query.eq('outcome', filters.outcome);
  if (filters.limit) query = query.limit(filters.limit);
  const { data, error } = await query;
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceRecipeRecord(row as Record<string, unknown>));
}

export async function createRecipeRecord(
  client: SupabaseClient,
  args: {
    recipeId: string;
    date: string;
    content: string;
    tags?: string[];
    outcome?: string | null;
    sourceConversationId?: string | null;
  }
): Promise<RecipeRecord> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('recipe_records')
    .insert({
      user_id: session.user.id,
      recipe_id: args.recipeId,
      date: args.date,
      content: args.content,
      tags: args.tags ?? [],
      outcome: args.outcome ?? null,
      source_conversation_id: args.sourceConversationId ?? null,
    })
    .select(RECORD_COLUMNS)
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceRecipeRecord(data as Record<string, unknown>);
}

/**
 * Patch a record's date, content, tags, or outcome. RLS owner-scopes
 * the update. The patch passes through untouched: supabase-js
 * serializes only the keys the caller set, so an omitted outcome
 * leaves the column alone while an explicit `outcome: null` clears the
 * classification - the distinction the M3 update tool's schema has to
 * name (the spurious-null hazard). The
 * `clear_recipe_record_embedding_on_change` trigger nulls the embedding
 * + claim columns when date or content changes so the worker re-embeds;
 * `touch_recipe_record_updated_at` stamps updated_at.
 */
export async function updateRecipeRecord(
  client: SupabaseClient,
  id: string,
  patch: { date?: string; content?: string; tags?: string[]; outcome?: string | null }
): Promise<RecipeRecord> {
  const { data, error } = await client
    .from('recipe_records')
    .update(patch)
    .eq('id', id)
    .select(RECORD_COLUMNS)
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceRecipeRecord(data as Record<string, unknown>);
}

export async function deleteRecipeRecord(
  client: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await client.from('recipe_records').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Head count of one recipe's records, for the delete confirmation's
 * "This deletes the recipe and its N records" line. `head: true` keeps
 * the row bodies off the wire - the caller wants a number, not the log.
 */
export async function countRecipeRecords(
  client: SupabaseClient,
  recipeId: string
): Promise<number> {
  const { count, error } = await client
    .from('recipe_records')
    .select('id', { count: 'exact', head: true })
    .eq('recipe_id', recipeId);
  if (error) throw new SupabaseError(error.message);
  return count ?? 0;
}

/**
 * Batched title lookup for cross-recipe search-hit labels: one
 * `.in('id', ids)` query per result set, never one read per hit.
 * Returns id -> title; a miss (recipe deleted since the search ran)
 * simply has no entry, and the row renders "(deleted recipe)".
 */
export async function fetchRecipeTitles(
  client: SupabaseClient,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error } = await client.from('recipes').select('id, title').in('id', ids);
  if (error) throw new SupabaseError(error.message);
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    if (typeof r.id === 'string') {
      out.set(r.id, typeof r.title === 'string' ? r.title : '');
    }
  }
  return out;
}

/**
 * Semantic + substring search across the user's recipe records
 * (optionally scoped to one recipe). Mirrors the wiki-records merge:
 * vector hits first (the search RPC), then ILIKE hits the vector path
 * missed, deduped by id, capped at `limit`. The caller's embedder
 * failure arrives as a null queryEmbedding and degrades to ILIKE-only,
 * so the search stays useful with the embedder down.
 *
 * `outcome` and `recipeId` filter BOTH legs: the search RPC takes
 * `p_recipe_id` / `p_outcome` and filters inside the RPC, before the
 * limit (post-filtering a capped result would mangle the counts); the
 * ILIKE leg applies the same filters as standalone `.eq()`s.
 *
 * Empty query short-circuits to a recent-first listing (same filters).
 * The ILIKE pattern is `ilikeFilterPattern`, NOT the logic-tree
 * builder: this is a standalone `.ilike()` filter, where PostgREST
 * strips no quotes (see query-utils.ts - reusing the quoted pattern
 * here is the twin's one-line bug, fixed in wiki-records.ts).
 */
export async function searchRecipeRecords(
  client: SupabaseClient,
  opts: {
    query: string;
    queryEmbedding: number[] | null;
    outcome?: string | null;
    recipeId?: string | null;
    limit?: number;
  }
): Promise<RecipeRecord[]> {
  const query = opts.query.trim();
  const limit = opts.limit ?? 20;

  if (query.length === 0) {
    let scoped = client.from('recipe_records').select(RECORD_COLUMNS);
    if (opts.recipeId) scoped = scoped.eq('recipe_id', opts.recipeId);
    if (opts.outcome) scoped = scoped.eq('outcome', opts.outcome);
    const { data, error } = await scoped
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceRecipeRecord(row as Record<string, unknown>));
  }

  const pattern = ilikeFilterPattern(query);
  let ilikeQuery = client.from('recipe_records').select(RECORD_COLUMNS);
  if (opts.recipeId) ilikeQuery = ilikeQuery.eq('recipe_id', opts.recipeId);
  if (opts.outcome) ilikeQuery = ilikeQuery.eq('outcome', opts.outcome);
  const ilikePromise = ilikeQuery
    .ilike('content', pattern)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  const semanticPromise = opts.queryEmbedding
    ? client.rpc('search_recipe_records_by_embedding', {
        query_embedding: opts.queryEmbedding,
        match_limit: limit,
        p_recipe_id: opts.recipeId ?? null,
        p_outcome: opts.outcome ?? null,
      })
    : Promise.resolve({ data: [] as unknown[], error: null });

  const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
  if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
  const ilikeRows = (ilikeRes.data ?? []).map((row) =>
    coerceRecipeRecord(row as Record<string, unknown>)
  );
  const semanticRows =
    semRes.error !== null
      ? []
      : ((semRes.data ?? []) as unknown[]).map((row) =>
          coerceRecipeRecord(row as Record<string, unknown>)
        );

  const out: RecipeRecord[] = [];
  const seen = new Set<string>();
  for (const r of semanticRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  for (const r of ilikeRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  return out;
}
