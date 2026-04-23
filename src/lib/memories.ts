/**
 * Shared semantic-search pipeline for memories.
 *
 * Originally inlined in `src/lib/tools/memory_search.ts` as part of the
 * LLM-facing `memory_search` tool. Extracted here so the Memories UI
 * (src/screens/Memories.svelte) can call the same pipeline without
 * synthesising a fake tool `ctx`. Both callers get identical results
 * whether the query comes from the model or from a human in the
 * browse-memories modal — a drift here would be a confusing bug
 * ("why doesn't the UI find what the assistant finds?").
 *
 * Why the ILIKE fallback: embeddings are populated by a background
 * worker that polls every ~30s. A memory the user just wrote is
 * `embedding is null` until the worker catches up, so a pure vector
 * search would hide it. We always run the ILIKE path against
 * unembedded rows and merge results in — vector hits first, then any
 * ILIKE hits the vector search missed. The merged set is deduped and
 * capped at `limit`.
 *
 * Why the silent Venice fallback: the UI — like the tool — shouldn't
 * show results that disappear when the embedding service hiccups.
 * Venice errors here route into `searchMemories(query, limit)`, which
 * gives ILIKE-only results. The caller never sees the network error;
 * we'd rather degrade to substring search than fail the whole list.
 */

import type { SupabaseService, Memory } from './supabase';
import type { VeniceClient } from './venice';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';

/**
 * Confidence thresholds used across the volitional-memory layer to turn
 * the raw scalar into a qualitative tag the LLM reads. Single source of
 * truth so retrieval (opening-recall, memory_search tool result),
 * Memories.svelte's UI badge, and tests all agree on the boundaries.
 *
 * Defaults and dynamics (see supabase/schema.sql for the RPCs):
 *   - memory_create default: 1.0 (-> no tag)
 *   - memory_reaffirm: +0.5 cap 10.0
 *   - memory_doubt:   x0.7 no floor
 *   - memory_invalidate (reflection only): x0.5 no floor
 *   - search-hide floor: confidence < 0.05 hides from search
 *
 * Eight reaffirms from default crosses [corroborated]; two doubts
 * crosses into [hedged]; five crosses into [shaky].
 */
export const MEMORY_CONFIDENCE_CORROBORATED = 5.0;
export const MEMORY_CONFIDENCE_NEUTRAL = 1.5;
export const MEMORY_CONFIDENCE_HEDGED = 0.5;

export type MemoryConfidenceTag = 'corroborated' | 'hedged' | 'shaky' | null;

/**
 * Map a numeric confidence onto a qualitative tag, or `null` when the
 * value is in the "default trust, no tag" band. Kept as a pure
 * classifier so callers can decide their own rendering (braces vs
 * uppercase vs icon).
 */
export function classifyMemoryConfidence(
  confidence: number
): MemoryConfidenceTag {
  if (confidence >= MEMORY_CONFIDENCE_CORROBORATED) return 'corroborated';
  if (confidence >= MEMORY_CONFIDENCE_NEUTRAL) return null;
  if (confidence >= MEMORY_CONFIDENCE_HEDGED) return 'hedged';
  return 'shaky';
}

/**
 * Render a confidence tag as a prose prefix. The bracketed form is
 * what gets injected into the LLM-facing memory text (opening-recall's
 * <think> block, memory_search's tool result), so the model reads its
 * own uncertainty without having to reason about numbers.
 *
 * Returns empty string (not a space) when the value is in the neutral
 * band - callers append this directly to the label and rely on a
 * single-space separator inside the tag itself to keep spacing clean.
 */
export function formatMemoryConfidenceTag(confidence: number): string {
  const tag = classifyMemoryConfidence(confidence);
  return tag === null ? '' : `[${tag}] `;
}

export interface SearchMemoriesDeps {
  supabase: SupabaseService;
  venice: VeniceClient | null;
  signal?: AbortSignal;
}

export async function searchMemoriesSemantic(
  query: string,
  limit: number,
  deps: SearchMemoriesDeps,
): Promise<Memory[]> {
  const { supabase, venice, signal } = deps;

  // Empty query: list everything most-recent-first. Matches the
  // assistant-facing tool's "leave `query` empty to list every
  // memory" contract.
  if (query.length === 0) return supabase.searchMemories('', limit);

  // No Venice client configured (e.g. the user hasn't entered a key
  // yet, or we're in an offline test). Straight to ILIKE; the user
  // still gets substring matches.
  if (!venice) return supabase.searchMemories(query, limit);

  let rawEmbedding: number[] | undefined;
  try {
    const response = await venice.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: query,
      signal,
    });
    rawEmbedding = response.data[0]?.embedding;
  } catch {
    // Silent fallback — the tool path does the same (see its comment
    // about not throwing when Venice is unreachable). An ILIKE result
    // set is strictly better than a hard error from the caller's POV.
    return supabase.searchMemories(query, limit);
  }

  if (!rawEmbedding || rawEmbedding.length === 0) {
    return supabase.searchMemories(query, limit);
  }

  // Vector search path. Pad to the column's storage dim — the RPC
  // parameter is `vector(EMBEDDING_STORAGE_DIMS)` and pgvector rejects
  // a mismatched-dim literal at the parser level, not with a useful
  // error. Padding is cosine-invariant (the zero suffix contributes
  // nothing to the dot product).
  const queryEmbedding = padEmbeddingForStorage(rawEmbedding);

  // Run the RPC and the unembedded-ILIKE probe in parallel — they hit
  // disjoint row sets (RPC filters `embedding is not null`, ILIKE path
  // filters `embedding is null`), so merging is a straight concat with
  // ordering by "vector first, then recency".
  const [vectorHits, ilikeHits] = await Promise.all([
    supabase.searchMemoriesByEmbedding(queryEmbedding, limit),
    supabase.searchUnembeddedMemoriesByText(query, limit),
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
}
