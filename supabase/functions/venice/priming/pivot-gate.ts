// pivot-gate: the decision-model semantic trigger for the pre-round
// priming stage.
//
// The deterministic evaluator (evaluatePreRoundTrigger in
// _shared/priming-triggers.ts) is blind to topic: a conversation can
// pivot subject completely while the mood band holds and the round
// count stays under the fuse - the next turn rides a stale synthesis -
// and a slow same-topic conversation pays the full refresh fan-out
// every 8 rounds even when the cache still informs perfectly. This
// module asks a decision model (clef-api, private tier - the user's
// own words are in the state) ONE noul question about the turn:
// does the user's message pivot the topic or raise something the
// cached payloads cannot inform?
//
// The gate COMPOSES with the deterministic evaluator, it never
// replaces it (plan docs/dev/plans/priming-pivot-gate-plan.md D1):
// a high probability fires a refresh ahead of the fuses (trigger
// 'pivot'); a low probability vetoes the ROUND-fuse 'stale' verdict
// (veto eligibility = wall-clock still fresh, judged by
// isPayloadFreshForInjection - the wall-clock fuse and the injection
// suppression stay absolute). Cold, mood, and wall-clock-stale
// verdicts are never consumed.
//
// Latency contract (plan D2): the gate starts when the samskara fire
// starts and races the SAME ceiling (PRIME_GATE_TIMEOUT_MS) - the
// pre-round stage can never wait longer for the gate than it already
// waits for the samskara race. Timeout / transport failure /
// malformed answer = fail-open (plan D3): the deterministic verdict
// stands.
//
// Pure + fetch-injectable like the sibling priming modules: the
// request shaping, coercion, and verdict composition are exported for
// tests; only runPivotGate performs I/O.

import {
  isPayloadFreshForInjection,
  type IntuitionTrigger,
  type RoundCacheSnapshot,
} from '../../_shared/priming-triggers.ts';
import { veniceDecision } from '../../_shared/venice.ts';

/** The gate's deadline, anchored to its own start. Same value as the
 *  samskara race's SAMSKARA_PRIMING_TIMEOUT_MS (priming.ts:68) and
 *  started at the same instant: the trigger evaluation waits for
 *  both, so the stage's wait is max of the two mins - never past the
 *  ceiling today's path already allows. Change the two together. */
export const PRIME_GATE_TIMEOUT_MS = 1500;

/** The noul probability at or above which the gate fires a refresh.
 *  The Decisions guide: probabilities vary between requests, so this
 *  was calibrated against real transcripts before landing (see the
 *  plan's D7) - it is the only knob. */
export const GATE_FIRE_THRESHOLD = 0.7;

/** Caps so the state digest stays a digest: low thousands of tokens,
 *  far under clef-api's 32k, and never the raw transcript (the
 *  perception pipeline owns the 1M-window transcript read). */
const USER_TEXT_MAX_CHARS = 4000;
const SYNTHESIS_HEAD_CHARS = 600;
const NOTE_HEAD_CHARS = 400;
const CLASSIFICATION_LINE_MAX_CHARS = 120;

interface GateCacheSnapshot extends RoundCacheSnapshot {
  computed_at_round: number;
  computed_at_at: number;
}

export interface PivotGateInputs {
  userText: string;
  /** The cached intuition payload, or null (cold / disabled). */
  intuitionCache: (GateCacheSnapshot & { perception: string; synthesis: string }) | null;
  /** The cached recall payload, or null. */
  recallCache: (GateCacheSnapshot & { note: string }) | null;
  round: number;
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  nowMs: number;
}

function firstLine(s: string, cap: number): string {
  const line = s.split('\n', 1)[0] ?? s;
  return line.length > cap ? line.slice(0, cap) : line;
}

function ageBlock(cache: GateCacheSnapshot, round: number, nowMs: number) {
  return {
    computed_at_round: cache.computed_at_round,
    rounds_ago: Math.max(0, round - cache.computed_at_round),
    minutes_ago: Math.round((nowMs - cache.computed_at_at) / 60_000),
  };
}

/**
 * Assemble the POST /decisions body. One noul question; the state is
 * the turn's user text plus a digest of both cached payloads (the
 * intuition perception line + synthesis head, the recall note head)
 * and their ages - enough for the model to judge "does the cache
 * still inform this message" without the transcript.
 */
export function buildGateRequest(inputs: PivotGateInputs): Record<string, unknown> {
  const state: Record<string, unknown> = {
    user_message: inputs.userText.slice(0, USER_TEXT_MAX_CHARS),
  };
  if (inputs.intuitionCache) {
    state.cached_intuition = {
      classification: firstLine(inputs.intuitionCache.perception, CLASSIFICATION_LINE_MAX_CHARS),
      synthesis_head: inputs.intuitionCache.synthesis.slice(0, SYNTHESIS_HEAD_CHARS),
      ...ageBlock(inputs.intuitionCache, inputs.round, inputs.nowMs),
    };
  }
  if (inputs.recallCache) {
    state.cached_recall = {
      note_head: inputs.recallCache.note.slice(0, NOTE_HEAD_CHARS),
      ...ageBlock(inputs.recallCache, inputs.round, inputs.nowMs),
    };
  }
  if (inputs.mood) state.mood = inputs.mood;
  return {
    model: 'clef-api',
    state,
    questions: {
      pivot: {
        type: 'noul',
        instructions:
          'Decide whether the user_message PIVOTS the conversation away from what the cached reads cover. ' +
          'The cached_intuition classification + synthesis and the cached_recall note describe what the ' +
          'assistant already understands about this conversation. A pivot means: the message starts a ' +
          'different subject, or raises a question/concern the cached reads would not inform. ' +
          'A continuation of the same subject, a follow-up, or small talk in the same register is NOT a pivot.',
        criteria: {
          true: 'The message pivots the topic or goes beyond what the cached reads could inform; a refresh is worth its cost.',
          false: 'The cached reads still inform this message; a refresh would re-derive what they already say.',
        },
      },
    },
  };
}

/**
 * Coerce the /decisions response into the noul probability, or null
 * when unusable (fail-open input). Any shape drift lands here as
 * null - the caller treats null as "the deterministic verdict
 * stands".
 */
export function coerceGateAnswer(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const pivot = (answers as Record<string, unknown>).pivot;
  if (!pivot || typeof pivot !== 'object') return null;
  const noul = (pivot as { noul?: unknown }).noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul)) return null;
  return Math.min(1, Math.max(0, noul));
}

export interface GateVerdictInput {
  /** The deterministic evaluator's verdict for this pipeline. */
  verdict: IntuitionTrigger | null;
  /** This pipeline's cache (the same snapshot the evaluator read). */
  cache: RoundCacheSnapshot | null;
  round: number;
  nowMs: number;
  /** The gate's noul probability, or null when unusable (fail-open). */
  gatePivot: number | null;
}

/**
 * Compose the deterministic verdict with the gate's answer for ONE
 * pipeline. Pure. The rules (plan D1/D2b):
 *  - 'cold' / 'mood' pass through untouched (unconditional refresh).
 *  - 'stale' vetoes to null only when the verdict came from the ROUND
 *    fuse (wall-clock still fresh) AND the gate is confident the cache
 *    informs (p < threshold). Unusable gate = 'stale' stands.
 *  - null verdict + a live, not-yet-debounced cache + confident gate =
 *    fire 'pivot'. Anything else stays null.
 */
export function composeTrigger(input: GateVerdictInput): IntuitionTrigger | null {
  const { verdict, cache, round, nowMs, gatePivot } = input;
  if (verdict === 'cold' || verdict === 'mood') return verdict;
  if (verdict === 'stale') {
    // Wall-clock-stale means the fuse was the absolute one: no veto.
    if (!cache || !isPayloadFreshForInjection(cache, nowMs)) return 'stale';
    if (gatePivot === null) return 'stale';
    return gatePivot >= GATE_FIRE_THRESHOLD ? 'pivot' : null;
  }
  // Null verdict: fire opportunity, but only on a live cache that the
  // same-round debounce has not already consumed this round.
  if (!cache || cache.computed_at_round >= round) return null;
  if (gatePivot === null) return null;
  return gatePivot >= GATE_FIRE_THRESHOLD ? 'pivot' : null;
}

export interface RunPivotGateOptions extends PivotGateInputs {
  apiKey: string;
  signal?: AbortSignal;
  log: { debug: (msg: string, err?: unknown) => void };
  fetchImpl?: typeof fetch;
}

/**
 * The live call: build the request, POST /decisions through
 * veniceDecision, race the deadline, coerce. Resolves null on any
 * failure or timeout (fail-open) and never throws - the priming
 * stage's never-throw contract holds.
 */
export async function runPivotGate(opts: RunPivotGateOptions): Promise<number | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const gateCall = veniceDecision({
      apiKey: opts.apiKey,
      body: buildGateRequest(inputsOf(opts)),
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    });
    const raced = await Promise.race([
      gateCall,
      new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), PRIME_GATE_TIMEOUT_MS);
      }),
    ]);
    return coerceGateAnswer(raced);
  } catch (err) {
    opts.log.debug('pivot gate failed; deterministic verdict stands', err);
    return null;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function inputsOf(opts: RunPivotGateOptions): PivotGateInputs {
  const { apiKey, signal, log, fetchImpl, ...inputs } = opts;
  return inputs;
}
