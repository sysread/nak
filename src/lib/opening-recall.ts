/**
 * Opening-turn memory recall. Embeds the user's first message in a
 * fresh thread, runs a scored cosine search against the memories
 * store, filters by a minimum similarity threshold, and formats the
 * surviving rows as a synthetic <think>...</think> block the chat
 * loop injects as an ephemeral assistant turn before the first real
 * assistant response.
 *
 * The chat loop's samskara priming handles the "what has the user
 * been like over time" block; this helper handles the "what do I
 * specifically remember that's relevant to THIS opening message"
 * block. They run in parallel from the same priming bundle and share
 * the same timeout guard - neither should ever block the first token
 * for more than SAMSKARA_PRIMING_TIMEOUT_MS.
 *
 * Why a <think> block rather than a system-prompt appendix: a
 * trailing <think> lets the model treat the recalled facts as its
 * own prior recollection it can weave into the reply naturally,
 * without the system-prompt voice shifting mid-prompt. The chat
 * loop pushes the returned string onto history as an assistant
 * message so it rides in the request as role=assistant content -
 * consecutive assistant messages, but Venice tolerates that and
 * our model picks don't require strict alternation.
 *
 * Why first-turn-only: later-turn recall is handled by the model
 * itself via the `memory_recall` tool (see its description and the
 * recall cadence block in buildSystemPrompt). Auto-injecting on
 * every turn would burn an embedding call per turn even on pure
 * chitchat, which is exactly what the memory_recall tool comment
 * argued against.
 *
 * Why ephemeral (not persisted): the injection is a per-request
 * synthetic, same shape as the <user_message> boundary tagging and
 * the samskara priming appendix. Persisting it would leak the fake
 * <think> turn into the thread UI, into conversation_recall's
 * transcript view, and into the reflection agent's read of the
 * settled thread - none of which want to see it.
 */

import type { MemoryRelation, SupabaseService } from './supabase';
import type { VeniceClient } from './venice';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';
import { createLogger } from './logger.svelte';
import { formatMemoryConfidenceTag } from './memories';

const log = createLogger('opening-recall');

/**
 * Max outbound edges to render per matched memory in the opening-recall
 * block. The fan-out cap keeps the <think> block bounded when a well-
 * connected memory has many relations - the graph can grow over time
 * but the priming budget can't. If more than this many edges exist, we
 * show the first N (by created_at asc, as the RPC returns them) and let
 * the rest surface via the Memories UI or a targeted memory_search.
 */
const OPENING_RECALL_RELATION_FANOUT = 5;

/**
 * Minimum boosted similarity score for a memory to be injected.
 * The scored RPC returns `(1 - cosine_distance) * (1 + 0.15 *
 * ln(1 + confidence))` - pure cosine on a fresh (confidence=1)
 * memory lands around 0.36, so 0.4 is a moderately-permissive
 * floor. Starting low on purpose; the diagnostic logging below
 * surfaces the score distribution so we can tune upward if
 * weak matches are polluting the priming.
 */
export const OPENING_RECALL_MIN_SCORE = 0.4;

/**
 * Top-N rows to ask the RPC for. We want 2-3 memories in the
 * <think> block; requesting 3 gives the threshold something to
 * filter against without over-fetching on cold threads.
 */
export const OPENING_RECALL_LIMIT = 3;

/**
 * Run the opening-turn recall pipeline. Returns the formatted
 * <think> block ready to drop into the assistant's content field,
 * or null when there's nothing to inject (empty user text, embed
 * failure, no rows, or every row below the threshold). Errors are
 * swallowed and logged - a recall failure must never block a chat
 * turn.
 */
export async function recallOpeningMemories(
  supabase: SupabaseService,
  venice: VeniceClient,
  userText: string,
  signal?: AbortSignal
): Promise<string | null> {
  const trimmed = userText.trim();
  if (trimmed.length === 0) {
    log.debug('skipping: empty user text');
    return null;
  }

  log.debug('embedding opening turn', { chars: trimmed.length });
  let rawEmbedding: number[] | undefined;
  try {
    const resp = await venice.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: trimmed,
      signal,
    });
    rawEmbedding = resp.data[0]?.embedding;
  } catch (err) {
    log.debug('embed failed', err);
    return null;
  }
  if (!rawEmbedding || rawEmbedding.length === 0) {
    log.debug('embed returned empty vector');
    return null;
  }

  const padded = padEmbeddingForStorage(rawEmbedding);

  let rows: Array<{
    id: string;
    label: string;
    data: string;
    confidence: number;
    similarity: number;
  }>;
  try {
    rows = await supabase.searchMemoriesByEmbeddingScored(
      padded,
      OPENING_RECALL_LIMIT
    );
  } catch (err) {
    log.debug('scored RPC failed', err);
    return null;
  }

  // Diagnostic: full distribution of what the search returned so we
  // can reason about whether the threshold is set sensibly. Dropped
  // at debug level because it runs on every opening turn.
  log.debug('scored results', {
    count: rows.length,
    scores: rows.map((r) => Number(r.similarity.toFixed(3))),
    confidences: rows.map((r) => Number(r.confidence.toFixed(2))),
    labels: rows.map((r) => r.label),
  });

  const matching = rows.filter((r) => r.similarity >= OPENING_RECALL_MIN_SCORE);
  if (matching.length === 0) {
    // Info level - a no-match opening turn is worth surfacing in the
    // log drawer because it's the "why didn't the model remember X"
    // diagnostic users will want to see.
    log.info('no matches above threshold', {
      threshold: OPENING_RECALL_MIN_SCORE,
      bestScore:
        rows.length > 0 ? Number(rows[0].similarity.toFixed(3)) : null,
      rowsReturned: rows.length,
    });
    return null;
  }

  // Pull outbound edges for the matched memories in a single batched
  // RPC, then group them back per source id. One round trip keeps the
  // priming budget bounded regardless of how many memories matched.
  // Failures degrade silently to "no relations" rather than wiping the
  // whole recall block - edges are an enrichment, not a requirement.
  let relationsByFrom = new Map<string, MemoryRelation[]>();
  try {
    const ids = matching.map((r) => r.id);
    const edges = await supabase.listMemoryRelationsFor(ids);
    relationsByFrom = groupRelationsByFrom(edges);
  } catch (err) {
    log.debug('relation fetch failed; continuing without edges', err);
  }

  log.info('opening recall matched', {
    matched: matching.length,
    thresholdedOut: rows.length - matching.length,
    topScore: Number(matching[0].similarity.toFixed(3)),
    labels: matching.map((r) => r.label),
    edgeCounts: matching.map((r) => relationsByFrom.get(r.id)?.length ?? 0),
  });

  return formatThinkBlock(matching, relationsByFrom);
}

/**
 * Bucket outbound relations by their `from_memory_id` so the formatter
 * can walk the matched rows in order without re-scanning the edge list
 * for each. Preserves the RPC's `order by created_at asc` ordering so
 * the earliest-drawn edge renders first under its source.
 */
function groupRelationsByFrom(
  edges: MemoryRelation[]
): Map<string, MemoryRelation[]> {
  const out = new Map<string, MemoryRelation[]>();
  for (const edge of edges) {
    const list = out.get(edge.from_memory_id);
    if (list) list.push(edge);
    else out.set(edge.from_memory_id, [edge]);
  }
  return out;
}

/**
 * Render the filtered memory rows as an assistant-content string
 * wrapped in <think>...</think>. The stem is a first-person musing
 * so the model reads it as its own prior recollection; each bullet is
 * the matched memory prefixed by its qualitative confidence tag, with
 * outbound edges indented under their source.
 *
 * Why the tag rides in the text itself: the model is better at picking
 * up hedging cues from inline language than from out-of-band metadata.
 * A [hedged] prefix nudges the reply toward "I think..." phrasing; a
 * [corroborated] one toward confident assertion. That leakage into the
 * model's voice is the intended effect of the volitional layer.
 *
 * Relations render as "  supports: [tag] <target label>: <target data>"
 * so the LLM sees the graph, not just a bag of disconnected memories.
 * Fan-out is capped per source by OPENING_RECALL_RELATION_FANOUT.
 */
function formatThinkBlock(
  rows: Array<{
    id: string;
    label: string;
    data: string;
    confidence: number;
  }>,
  relationsByFrom: Map<string, MemoryRelation[]>
): string {
  const lines: string[] = [];
  for (const r of rows) {
    const tag = formatMemoryConfidenceTag(r.confidence);
    lines.push(`- ${tag}${r.label}: ${r.data}`);
    const edges = relationsByFrom.get(r.id) ?? [];
    for (const edge of edges.slice(0, OPENING_RECALL_RELATION_FANOUT)) {
      const toTag = formatMemoryConfidenceTag(edge.to_confidence);
      lines.push(
        `  ${edge.kind}: ${toTag}${edge.to_label}: ${edge.to_data}`
      );
    }
  }
  return (
    "<think>Let's see, this is what I remember off the top of my head " +
    "about the user's prompt...\n" +
    lines.join('\n') +
    '\n</think>'
  );
}
