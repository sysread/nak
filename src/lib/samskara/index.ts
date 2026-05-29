/**
 * Public surface for the samskara feature on the chat-loop side.
 *
 * The chat loop has exactly three integration points and they all
 * live behind this module:
 *
 *   - `getCompoundSummary(supabase)` — read the cached prose summary
 *     row at round-1 entry. Returns null when cold-start or when the
 *     cache is stale enough that we'd rather inject nothing.
 *   - `fireSamskaras(supabase, venice, threadId, userRound, userText)`
 *     — embed the user's input, run the cosine fire RPC, and persist
 *     the resulting cohort. Returns the fired set so the caller can
 *     format the priming block. The cohort id is generated here and
 *     written to the fire log along with the user-round index, so
 *     reaction-classify in the worker can later resolve the cohort
 *     as a unit and the per-message inline UI can anchor each cohort
 *     to the user message that triggered it.
 *   - `recordSubstrateStub(supabase, threadId, msgIds)` — insert the
 *     per-round substrate row at end-of-round. The assimilator phase
 *     of the formation worker enriches it later; this call is fast
 *     and LLM-free.
 *
 * Plus `formatPrimingThinks` which is pure (no IO) and lives in
 * `./format`. It projects the compound summary + situational fire
 * into two `<think>` block bodies (one for each signal); the chat-loop
 * wraps the non-null bodies in `<think>` tags and pushes them as
 * separate assistant messages alongside the context-recall and
 * intuition synthetic turns.
 *
 * The module is deliberately small: anything more complex (the
 * formation pipeline, the agent prompts, the worker loop) lives
 * under `src/lib/agents/samskara/`. This file is the chat-loop's
 * mental contract with the feature.
 */
import type { SupabaseService } from '../supabase';
import {
  VENICE_EMBEDDING_MODEL,
  padEmbeddingForStorage,
} from '../models';
import { topKForCorpusSize } from './format';
import { K_BASE, STALE_CEILING_HOURS } from './types';
import type { FireResult } from './types';
import { createLogger } from '../logger.svelte';

const log = createLogger('samskara');

export type { FireResult } from './types';
export { formatPrimingThinks } from './format';
export type { PrimingThinks } from './format';

/**
 * Read the cached compound summary. Returns null when the row is
 * absent (cold start), the summary string is empty, or the cache is
 * older than `STALE_CEILING_HOURS`. The chat-loop reader treats null
 * as "no compound block this turn"; the formatter renders only the
 * fire section if any.
 */
export async function getCompoundSummary(
  supabase: SupabaseService
): Promise<string | null> {
  // Swallow fetch/RPC failures. supabase-js re-throws the raw fetch
  // TypeError ("Failed to fetch") when the network blips, which
  // without this guard bubbled up through chat-loop's Promise.all
  // priming block and surfaced as a "TypeError: Failed to fetch"
  // banner at turn-start or when sending the next message after a
  // completion. The chat-loop's contract (see chat-loop.ts above the
  // priming block) is that samskara helpers never fail a turn;
  // fireSamskaras already swallows, this now matches.
  let row;
  try {
    row = await supabase.samskaraGetCompoundSummary();
  } catch (err) {
    log.debug('compound summary read failed', err);
    return null;
  }
  if (!row || !row.summary || row.summary.length === 0) {
    log.debug('compound summary: empty (cold start)');
    return null;
  }
  if (row.lastRegenAt) {
    const ageMs = Date.now() - new Date(row.lastRegenAt).getTime();
    if (ageMs > STALE_CEILING_HOURS * 60 * 60 * 1000) {
      log.debug('compound summary: stale, ignoring', {
        ageHours: Math.round(ageMs / 3_600_000),
        ceilingHours: STALE_CEILING_HOURS,
      });
      return null;
    }
  }
  log.debug('compound summary: loaded', { chars: row.summary.length });
  return row.summary;
}

/**
 * Embed the user's text, run the cosine fire RPC, and persist the
 * cohort. Returns null when there are no samskaras yet or the user
 * text is empty — the caller renders priming without a fire section
 * in either case.
 *
 * Cohort id: generated here as a uuid via crypto.randomUUID and
 * written into every fire row in the same RPC. The reaction
 * classifier in the worker uses cohort_id to score the set as a
 * unit (cohort-aware reinforcement weighting) and to mark the entire
 * cohort resolved in one update.
 *
 * Errors are swallowed and logged: a fire failure should NOT block
 * the user's chat turn. The chat-loop continues with no priming
 * appendix from this fire if anything goes wrong.
 */
export async function fireSamskaras(
  supabase: SupabaseService,
  threadId: string,
  userRound: number,
  userText: string,
  signal?: AbortSignal
): Promise<FireResult | null> {
  const trimmed = userText.trim();
  if (trimmed.length === 0) {
    log.debug('fire: empty user text, skipping');
    return null;
  }

  log.debug('fire: embedding user text', { chars: trimmed.length });
  let rawEmbedding: number[] | undefined;
  try {
    const resp = await supabase.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: trimmed,
      signal,
    });
    rawEmbedding = resp.data[0]?.embedding;
  } catch (err) {
    log.debug('fire embed failed', err);
    return null;
  }
  if (!rawEmbedding || rawEmbedding.length === 0) {
    log.debug('fire: embed returned empty vector');
    return null;
  }

  // Pad for query — pgvector requires the query embedding to match
  // the column dim exactly. Same helper memories use; cosine is
  // invariant to the zero-extension.
  const padded = padEmbeddingForStorage(rawEmbedding);

  // Top-k: log10-dampened. We don't know the true corpus size at
  // this layer without an extra round trip, so we ask for a generous
  // 25 (K_BASE=5, log10(100+10) ~= 2.04, ceil = 11 — bump to 25
  // because the long tail is what the design is built around). The
  // RPC returns at most that many; the formatter trims by token
  // budget, not by row count.
  const kMax = topKForCorpusSize(100, K_BASE) * 2;

  let rows;
  try {
    rows = await supabase.samskaraFireTopK(padded, kMax);
  } catch (err) {
    log.debug('fire RPC failed', err);
    return null;
  }
  if (!rows || rows.length === 0) {
    log.debug('fire: top-k returned 0 rows (corpus empty or no matches)');
    return null;
  }

  const cohortId = generateCohortId();
  const fired = rows.map((r) => ({
    id: r.id,
    prediction: r.prediction,
    innerVoice: r.inner_voice,
    valence: r.valence,
    confidence: r.confidence,
    health: r.health,
    score: r.score,
  }));
  log.info('fire: cohort formed', {
    cohortId,
    threadId,
    size: fired.length,
    topScore: fired[0]?.score,
  });

  // Persist the cohort. Errors here are logged but not surfaced —
  // the priming block still renders even if the fire log write
  // failed (the next reaction-classify pass simply has no cohort to
  // score). Better than failing the user-visible chat turn.
  try {
    await supabase.samskaraRecordFires(
      cohortId,
      threadId,
      userRound,
      fired.map((f) => ({ samskaraId: f.id, score: f.score }))
    );
  } catch (err) {
    log.debug('fire log write failed', err);
  }

  return { cohortId, fired };
}

/**
 * Insert the per-round substrate stub. Called from the chat loop at
 * end-of-round with the message ids that just persisted. Errors are
 * swallowed so substrate write failures don't bubble into a user-
 * visible failure — the formation pipeline simply has fewer rows to
 * work from until the next round writes successfully.
 */
export async function recordSubstrateStub(
  supabase: SupabaseService,
  threadId: string,
  userMessageId: string,
  assistantMessageId: string | null
): Promise<void> {
  try {
    await supabase.samskaraRecordSubstrate(threadId, userMessageId, assistantMessageId);
    log.debug('substrate stub recorded', {
      threadId,
      userMessageId,
      assistantMessageId,
    });
  } catch (err) {
    log.debug('substrate stub write failed', err);
  }
}

/**
 * Cohort-id generator. Wrapper over crypto.randomUUID with the same
 * Math.random fallback `makeHolderId` (`src/lib/agents/holder.ts`)
 * uses, so this file is independently testable from any browser-
 * only assumption.
 */
function generateCohortId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: hosts without crypto.randomUUID (ancient Safari). Not
  // cryptographically strong, but cohort-id only needs to be unique
  // within the user's fire log.
  return `cohort-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
