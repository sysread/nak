/**
 * The context-recall pipeline. Sibling of the intuition pipeline,
 * fired on the same trigger machinery (cold-start, mid-turn title
 * change, mood-band shift, stale fuse) but doing different work:
 *
 *   1. Gather a works-cited index across the three persistent layers
 *      (memories / conversations / wiki) via deterministic search -
 *      see `gatherContextIndex` in ./gather.ts. No LLM sub-agents.
 *   2. Render the index into a short first-person note that the
 *      chat-loop injects as a synthetic <think> assistant turn.
 *
 * Why a pipeline instead of a tool the main model calls: topic-
 * boundary recall is reflexive, not a per-turn decision. The
 * trigger evaluator (shared with intuition) already knows when a
 * topic boundary lands; routing context recall through that
 * evaluator removes one prompt instruction the main model would
 * otherwise have to remember and a tool round-trip on every cold-
 * start / title shift / stale-fuse fire.
 *
 * Why deterministic gather, not LLM synthesis: the prior design ran
 * three headless recall sub-agents that synthesized first-person
 * notes. That synthesis hallucinated (paraphrasing a memory into a
 * claim the store never made) and cost three model round-trips on
 * every topic boundary. The index includes memory facts verbatim and
 * references conversations / wiki articles by id for on-demand drill-
 * down (`conversation_get` / `wiki_get`); see ./gather.ts. The per-
 * layer recall TOOLS (memory_recall, conversation_recall, wiki_recall)
 * keep the LLM sub-agents as the targeted-drill-down tier - this
 * pipeline is the cheap survey tier.
 *
 * Failure model:
 *   - Each search layer degrades independently inside the gather; one
 *     throwing or returning nothing contributes an empty list rather
 *     than failing the whole run.
 *   - When every layer is empty the pipeline still returns a payload -
 *     with `note: ''` - so the trigger evaluator's same-round debounce
 *     holds. Caching the negative result is the whole point of writing
 *     the empty case at all.
 *   - A signal abort returns null (no payload written). Caller leaves
 *     the prior cache in place. Same posture as the intuition pipeline.
 */
import type { SupabaseService } from '../supabase';
import type { IntuitionTrigger } from '../intuition/types';
import { createLogger } from '../logger.svelte';
import type { ContextRecallPayload } from './types';
import { evaluatePreRoundTrigger } from '../intuition/triggers';
import { withContextRecallInflight } from './cache';
import { gatherContextIndex, renderContextThink } from './gather';

const log = createLogger('context-recall');

export interface RunContextRecallInputs {
  supabase: SupabaseService;
  /** Thread we're recalling for. */
  threadId: string;
  /** Signed-in user id. */
  userId: string;
  signal: AbortSignal;
  /** Round id (= count of user messages in history) at run time.
   *  Same value across all chat-loop iterations of one user turn. */
  round: number;
  /** Mood snapshot at run time, or null when no mood is available
   *  (cold start, mood-clear thread). */
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  /** Why this run was scheduled. Persisted on the payload for
   *  observability. */
  trigger: IntuitionTrigger;
}

/**
 * Run the full pipeline. Returns the cache-ready payload (which may
 * carry an empty note - that's a legitimate cached state representing
 * "nothing to recall this round"), or null if the run was aborted
 * before the gather completed. Caller is responsible for persisting
 * the payload to the thread row - see ./cache.ts.
 */
export async function runContextRecallPipeline(
  inputs: RunContextRecallInputs
): Promise<ContextRecallPayload | null> {
  // userId rides on the inputs for caller symmetry with the intuition
  // pipeline, but the gather authenticates through the Supabase client's
  // RLS context rather than an explicit id, so it is not destructured.
  const { supabase, threadId, signal, round, mood, trigger } = inputs;
  const startedAt = Date.now();
  log.info('pipeline starting', { trigger, round });

  if (signal.aborted) return null;

  // Total safety net. gatherContextIndex isolates each search layer
  // internally, but the parts outside the layers (the listMessages read
  // and deriveRecallQuery that build the query) can still throw. This
  // pipeline is awaited on the live turn's critical path
  // (chat-loop.ts fires it on the cold-start trigger of a brand-new
  // thread, among others), so a throw here would crash the user's chat
  // turn rather than degrade priming. Mirror the intuition pipeline's
  // posture: any failure returns null, the caller leaves the prior
  // cache in place, and the turn proceeds with no recall block.
  let index;
  try {
    index = await gatherContextIndex({
      supabase,
      threadId,
      signal,
    });
  } catch (err) {
    log.warn('gather failed; skipping recall this round', err);
    return null;
  }

  if (signal.aborted) return null;

  const note = renderContextThink(index);

  const payload: ContextRecallPayload = {
    v: 1,
    note,
    computed_at_round: round,
    computed_at_band: mood?.band ?? null,
    computed_at_column: mood?.column ?? null,
    computed_at_at: Date.now(),
    trigger,
  };

  // Mirrors the intuition pipeline's "complete" log line. The per-layer
  // hit counts tell a debugging eye which layers carried signal on a
  // given thread - useful for "why is wiki recall always silent here?"
  // investigations without per-tool timing instrumentation.
  log.info('pipeline complete', {
    trigger,
    round,
    memoryCount: index.memories.length,
    conversationCount: index.conversations.length,
    wikiCount: index.wiki.length,
    noteLength: note.length,
    elapsedMs: Date.now() - startedAt,
  });
  return payload;
}

/**
 * Inputs for maybeRunContextRecallPipeline - the run inputs minus
 * the trigger (derived by the evaluation here).
 */
export interface MaybeRunContextRecallInputs
  extends Omit<RunContextRecallInputs, 'trigger'> {
  /** Feature gate (the chat-loop's contextRecallEnabled option);
   *  undefined means off, matching the option's optionality. */
  enabled: boolean | undefined;
  /** Current cached payload off the thread row; null = cold start. */
  cache: ContextRecallPayload | null;
  /** Current wall-clock time, ms since epoch. Feeds the wall-clock
   *  staleness fuse in the shared trigger evaluator; same Date.now()
   *  snapshot the chat-loop hands the intuition run and the injection
   *  guard. */
  nowMs: number;
  /**
   * Fires at the moment the pipeline commits to running, before the
   * gather starts - the caller hangs its UI status signal here.
   * Never called on a no-trigger or feature-off turn.
   */
  onWillRun?: (trigger: IntuitionTrigger) => void;
}

/**
 * The chat-loop's entry point - the context-recall twin of
 * maybeRunIntuitionPipeline. Owns the feature gate, the trigger
 * evaluation (the shared evaluator; ContextRecallPayload satisfies
 * its RoundCacheSnapshot shape structurally), and the per-thread
 * inflight dedup. Resolves null on feature-off, no-trigger, and
 * pipeline failure alike.
 */
export function maybeRunContextRecallPipeline(
  inputs: MaybeRunContextRecallInputs
): Promise<ContextRecallPayload | null> {
  if (inputs.enabled !== true) return Promise.resolve(null);
  const trigger = evaluatePreRoundTrigger({
    cache: inputs.cache,
    round: inputs.round,
    mood: inputs.mood,
    nowMs: inputs.nowMs,
  });
  if (!trigger) return Promise.resolve(null);
  inputs.onWillRun?.(trigger);
  return withContextRecallInflight(inputs.threadId, () =>
    runContextRecallPipeline({
      supabase: inputs.supabase,
      threadId: inputs.threadId,
      userId: inputs.userId,
      signal: inputs.signal,
      round: inputs.round,
      mood: inputs.mood,
      trigger,
    })
  );
}
