/**
 * Shared semantic-search pipeline for recipe records: the recipe port
 * of `searchWikiRecordsSemantic` (`src/lib/wiki.ts`), driving the
 * Records section's search box. Embed the query via Venice (silent
 * ILIKE-only fallback on failure - a transient Venice error shouldn't
 * blank the search), then hand the embedding to
 * `SupabaseService.searchRecipeRecords`, which merges vector hits with
 * ILIKE hits deduped by id. No sole-source filter - records have no
 * provenance-exclusion semantic.
 *
 * The options-object signature is a deliberate divergence from the
 * twin's positional `(query, limit, deps)`: the optional outcome and
 * recipe filters thread through here, the facade, the merge, and both
 * merge legs, and an options object keeps that readable. Like the
 * twin, the service and abort signal are injected (no `app` import),
 * so the .svelte consumer stays embed-free and supersede-able, and the
 * embed call never lands inside a component.
 */
import type { RecipeRecord, SupabaseService } from './supabase';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';

interface SearchRecipeRecordsOptions {
  query: string;
  limit: number;
  /** Optional outcome filter (success | mixed | failure); both merge legs honor it. */
  outcome?: string | null;
  /** Optional recipe scope; both merge legs honor it. */
  recipeId?: string | null;
  supabase: SupabaseService;
  signal?: AbortSignal;
}

export async function searchRecipeRecordsSemantic(
  opts: SearchRecipeRecordsOptions
): Promise<RecipeRecord[]> {
  const { supabase, signal, outcome, recipeId } = opts;
  const trimmed = opts.query.trim();
  if (trimmed.length === 0) {
    // Empty query: skip the embed call entirely and let the merge's
    // short-circuit return a recent-first listing (same filters).
    return supabase.searchRecipeRecords({
      query: '',
      queryEmbedding: null,
      outcome,
      recipeId,
      limit: opts.limit,
    });
  }
  let rawEmbedding: number[] | undefined;
  try {
    const response = await supabase.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: trimmed,
      signal,
    });
    rawEmbedding = response.data[0]?.embedding;
  } catch {
    // Silent fallback - a transient Venice error shouldn't blank the
    // records search; ILIKE-only beats a hard error.
    rawEmbedding = undefined;
  }
  const queryEmbedding =
    rawEmbedding && rawEmbedding.length > 0
      ? padEmbeddingForStorage(rawEmbedding)
      : null;
  return supabase.searchRecipeRecords({
    query: trimmed,
    queryEmbedding,
    outcome,
    recipeId,
    limit: opts.limit,
  });
}
