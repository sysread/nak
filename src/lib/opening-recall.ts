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

import type { SupabaseService } from './supabase';
import type { VeniceClient } from './venice';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';
import { createLogger } from './logger.svelte';

const log = createLogger('opening-recall');

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

  let rows: Array<{ id: string; label: string; data: string; similarity: number }>;
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

  log.info('opening recall matched', {
    matched: matching.length,
    thresholdedOut: rows.length - matching.length,
    topScore: Number(matching[0].similarity.toFixed(3)),
    labels: matching.map((r) => r.label),
  });

  return formatThinkBlock(matching);
}

/**
 * Render the filtered memory rows as an assistant-content string
 * wrapped in <think>...</think>. The stem is a first-person musing
 * so the model reads it as its own prior recollection; the bullet
 * list that follows is the raw memory data verbatim (label + data)
 * because the model is better at integrating facts from structured
 * text than from a re-summarised blob.
 */
function formatThinkBlock(
  rows: Array<{ label: string; data: string }>
): string {
  const lines = rows.map((r) => `- ${r.label}: ${r.data}`);
  return (
    "<think>Let's see, this is what I remember off the top of my head " +
    "about the user's prompt...\n" +
    lines.join('\n') +
    '\n</think>'
  );
}
