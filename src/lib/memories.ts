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
 * Why the ILIKE fallback: embeddings are populated by a server-side
 * backfill that runs every minute. A memory the user just wrote is
 * `embedding is null` until the backfill catches up, so a pure vector
 * search would hide it. We always run the ILIKE path against
 * unembedded rows and merge results in - vector hits first, then any
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
import { UNTAGGED_TOPIC_SENTINEL } from './supabase';
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

/**
 * Max length of the commit-message-style change line that lands in the
 * memory_changelog. Mirrors the column-level CHECK (char_length between
 * 1 and 200) in supabase/schema.sql:memory_changelog - keep the two in
 * sync. The create/update/delete tools and the Memories.svelte edit and
 * delete flows all validate against this before writing.
 */
export const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;

/**
 * Hard cap on memory `data` length, enforced at every memory write
 * boundary (memory_create / memory_update / memory_consolidate /
 * memory_reshape, plus the Memories.svelte edit flow). The server-side
 * embedding backfill applies the same cap defensively when composing
 * Venice input (supabase/functions/_shared/embed-input.ts).
 *
 * The binding constraint is RECALL COST, not the embedding window.
 * Memory bodies ride inline into the context-recall smoothing prompt -
 * CONTEXT_MEMORY_LIMIT (6) rows, verbatim, on the live turn's critical
 * path - and that prompt is re-sent on every recall trigger. The cap is
 * therefore sized so six worst-case bodies stay affordable rather than
 * so one body fits the encoder.
 *
 * Why this number: measured against a real store, the p75 body was
 * ~2286 chars while the top-6 gather shipped ~19k chars per recall,
 * because the rewrite paths ratchet bodies upward (see the non-growth
 * rule in tools/_memory_data_budget.ts). 2500 sits just above p75, so
 * it binds on the long tail that drives the cost without fighting the
 * bulk of the corpus.
 */
export const MAX_MEMORY_DATA_CHARS = 2500;

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
  signal?: AbortSignal;
  /**
   * Optional topic filter from the Memories drawer's TopicsFilter.
   * Empty array (the default) means "no filter active" - the
   * assistant-facing memory_search tool always passes nothing here
   * since the model has no topic-selection UI. ILIKE/vector hits
   * narrow to rows whose `topics` overlap the selection; the
   * UNTAGGED_TOPIC_SENTINEL ("(untagged)") matches rows with an
   * empty topics array.
   */
  selectedTopics?: readonly string[];
}

/**
 * Decide whether a memory row passes a topic filter. Empty selection
 * always passes (filter inactive). The UNTAGGED_TOPIC_SENTINEL matches
 * rows whose `topics` is empty - that's how the UI surfaces "rows the
 * worker hasn't reached" alongside real topic selections. Used to
 * filter vector hits client-side because `search_memories_by_embedding`
 * returns `topics` on each row but can't take a filter argument (the
 * RPC's ordering+limit shape would need a more invasive change to
 * filter pre-order, and the post-order filter would distort the score
 * ranking anyway - client-side keeps the contract simple).
 */
function memoryMatchesTopicFilter(
  row: Memory,
  selectedTopics: readonly string[]
): boolean {
  if (selectedTopics.length === 0) return true;
  let includeUntagged = false;
  const real: string[] = [];
  for (const t of selectedTopics) {
    if (t === UNTAGGED_TOPIC_SENTINEL) includeUntagged = true;
    else real.push(t);
  }
  const rowTopics = Array.isArray(row.topics) ? row.topics : [];
  if (rowTopics.length === 0 && includeUntagged) return true;
  if (real.length > 0 && rowTopics.some((t) => real.includes(t))) return true;
  return false;
}

export async function searchMemoriesSemantic(
  query: string,
  limit: number,
  deps: SearchMemoriesDeps,
): Promise<Memory[]> {
  const { supabase, signal, selectedTopics = [] } = deps;

  // Empty query: list everything most-recent-first. Matches the
  // assistant-facing tool's "leave `query` empty to list every
  // memory" contract.
  if (query.length === 0) return supabase.searchMemories('', limit, selectedTopics);

  // Embed the query through the venice edge function (SupabaseService.embed).
  // A failure - no shared key configured, function/Venice unreachable - falls
  // to the ILIKE path in the catch below, so the user still gets substring
  // matches without a hard error.
  let rawEmbedding: number[] | undefined;
  try {
    const response = await supabase.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: query,
      signal,
    });
    rawEmbedding = response.data[0]?.embedding;
  } catch {
    // Silent fallback — the tool path does the same (see its comment
    // about not throwing when Venice is unreachable). An ILIKE result
    // set is strictly better than a hard error from the caller's POV.
    return supabase.searchMemories(query, limit, selectedTopics);
  }

  if (!rawEmbedding || rawEmbedding.length === 0) {
    return supabase.searchMemories(query, limit, selectedTopics);
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
  // ordering by "vector first, then recency". The ILIKE probe carries
  // the topic filter server-side; vector hits get it applied client-
  // side below (RPC returns `topics` on each row for exactly that).
  const [vectorHits, ilikeHits] = await Promise.all([
    supabase.searchMemoriesByEmbedding(queryEmbedding, limit),
    supabase.searchUnembeddedMemoriesByText(query, limit, selectedTopics),
  ]);

  const seen = new Set<string>();
  const merged: Memory[] = [];
  for (const row of vectorHits) {
    if (seen.has(row.id)) continue;
    if (!memoryMatchesTopicFilter(row, selectedTopics)) continue;
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
