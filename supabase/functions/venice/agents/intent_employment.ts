// Intent employment classification (function-side, cron-only). The
// settled-thread judge that records, for each intention that was active
// during a conversation, what actually HAPPENED with it: was there an
// opening to act on it, did the assistant act, and how did the user
// react. Writes intent_employments rows. See
// docs/dev/in-progress/intents.md.
//
// This is the minter's pruning telemetry - it lets a daily mint pass
// tell "the lever is wrong" (openings keep arising, efficacy low) apart
// from "the pattern has gone quiet" (no openings). It is process
// telemetry ONLY and is NEVER an efficacy input; the firewall (efficacy
// reads descriptive-layer movement, employment reads conversations)
// keeps the loop honest, and the schema's table separation makes a
// wrong wiring obvious in review.
//
// v2: the judge is a Decisions API call (veniceDecision, clef-api,
// private tier) - three typed questions per active intent (opening
// noul, acted noul, reaction choice) over the transcript serialized
// as decision-call STATE, so no prose is generated and no JSON
// contract exists to parse. The bookkeeping framing and the
// no-invented-openings rules travel in the question instructions;
// the reasoning sentence v1 wrote is gone (telemetry with zero
// readers - the column receives '').
//
// Shape mirrors the bias analyze phase: claim the most-overdue settled
// thread whose intent_active_at_turn snapshot is non-empty (intents
// were live during it) cross-user, run one judge over the transcript,
// save under the claim + message-count guard, stamp processed. Gated on
// the intentsEnabled toggle at the claim, so an opted-out user is never
// processed. The request builder, coercion, and failure
// classifier are pure and pinned by the Deno suite at
// supabase/functions/tests/intent_employment.test.ts via __test; the
// state shaping (the transcript serializer, the clip caps, the
// answers coercers, the item cap, the call timeout) is shared with
// the other decision judges - see _decision_state.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { VeniceError, veniceDecision } from '../../_shared/venice.ts';
import {
  loadThreadSlice,
  trimToCharBudget,
} from './_recall_helpers.ts';
import {
  answersOf,
  choiceOf,
  DECISION_CALL_TIMEOUT_MS,
  DECISION_ITEM_CAP,
  noulOf,
  serializeTranscript,
} from './_decision_state.ts';
import { INTENT_EMPLOYMENT_MODEL } from '../../_shared/agent-models.ts';
const INTENT_EMPLOYMENT_CLAIM_TTL_SECONDS = 300;
const INTENT_EMPLOYMENT_MIN_USER_MESSAGES = 2;
// Threads processed per tick - bounds a tick's Venice spend; a backlog
// drains across daily ticks, same discipline as the bias analyze cap.
const INTENT_EMPLOYMENT_SWEEP_CAP = 10;

// The noul probability at or above which a boolean question reads as
// "yes" - the neutral cut. The probabilities are logged per tag, so a
// future calibration can retune this against real distributions.
const EMPLOYMENT_NOUL_THRESHOLD = 0.5;

// Serialized-state budget: clef-api's state cap is 32k tokens; ~4
// chars per token puts 80k chars at ~20k tokens, leaving room for the
// questions under the 32k total. CJK-heavy transcripts run ~1-3
// chars/token and can overflow - the decision response's usage is
// logged so the real ratio is visible. (This trim budget is B4's own
// knob, applied at the call site via trimToCharBudget; the serializer
// clip caps live in _decision_state.ts.)
const EMPLOYMENT_STATE_BUDGET_CHARS = 80_000;

/** The firewall framing, carried into every question's instructions. */
const BOOKKEEPING =
  'This is bookkeeping about behavior - NOT a judgment of whether the intention is good, working, or worth keeping.';

export interface EmploymentIntent {
  tag: string;
  id: string;
  statement: string;
}

export type EmploymentReaction = 'receptive' | 'neutral' | 'resistant';

export interface EmploymentVerdict {
  opening: boolean;
  acted: boolean;
  reaction: EmploymentReaction | null;
}

/**
 * Assemble the POST /decisions body: the transcript + the tagged
 * intent list as state, three questions per intent (opening noul,
 * acted noul, reaction choice). The v1 prompt's rules live here in
 * the question instructions/criteria - the bookkeeping framing, the
 * no-invented-openings rule, and the acted-needs-evidence rule -
 * because verdict-shaping travels with the verdict (the B2 pattern).
 */
export function buildEmploymentRequest(
  intents: readonly EmploymentIntent[],
  transcript: string,
): Record<string, unknown> {
  const state = {
    transcript,
    intents: intents.map(({ tag, statement }) => ({ tag, statement })),
  };
  const questions: Record<string, unknown> = {};
  for (const { tag, statement } of intents) {
    questions[`opening-${tag}`] = {
      type: 'noul',
      instructions:
        `Assess the assistant's standing intention tagged ${tag} ` +
        `("${statement}") against the transcript. ${BOOKKEEPING} ` +
        'Decide whether a natural moment to act on this intention actually ' +
        'arose in the conversation. Do not invent openings that were not ' +
        'there - many turns simply give no occasion for a given intention.',
      criteria: {
        true: 'A natural moment to act on this intention arose in the conversation.',
        false: 'No occasion for this intention arose in the conversation.',
      },
    };
    questions[`acted-${tag}`] = {
      type: 'noul',
      instructions:
        `Assess the assistant's standing intention tagged ${tag} ` +
        `("${statement}"). ${BOOKKEEPING} Decide whether the assistant ` +
        'actually leaned on the intention in this conversation. Answer yes ' +
        "only if you can point to where the lean shows in the assistant's " +
        'replies. If there was no opening, this is no.',
      criteria: {
        true: 'The assistant leaned on the intention, visibly, in its replies.',
        false: 'No opening arose, or the assistant did not lean on the intention.',
      },
    };
    questions[`reaction-${tag}`] = {
      type: 'choice',
      instructions:
        `If the assistant acted on the assistant's standing intention tagged ` +
        `${tag} ("${statement}"), how did the user respond to that lean? ` +
        `${BOOKKEEPING} Choose "none" when the assistant did not act on this ` +
        "intention, or the user's response to the lean is not observable in " +
        'the transcript.',
      criteria: {
        receptive: 'The assistant acted and the user engaged with the lean or welcomed it.',
        neutral: 'The assistant acted and the user gave no clear signal either way.',
        resistant: 'The assistant acted and the user pushed back, deflected, or ignored the lean.',
        none: "The assistant did not act on this intention, or the user's response is not observable.",
      },
    };
  }
  return { model: INTENT_EMPLOYMENT_MODEL, state, questions };
}

/**
 * Coerce the /decisions response into per-tag verdicts. Transport +
 * validation only: each tag needs a usable noul under BOTH boolean
 * question ids; opening reads from the 0.5 cut; acted can only be
 * true if there was an opening (the prompt says so, and v1's parser
 * enforced it - so does this); reaction reads from the choice answer
 * only when acted, in the allowed set, else null. A tag with missing
 * or malformed answers is dropped (best-effort; the thread is stamped
 * either way, same as v1's dropped entries). Returns a Map keyed by
 * tag.
 */
export function parseEmploymentVerdicts(
  payload: unknown,
  validTags: ReadonlySet<string>,
): Map<string, EmploymentVerdict> {
  const out = new Map<string, EmploymentVerdict>();
  const a = answersOf(payload);
  if (!a) return out;
  for (const tag of validTags) {
    const openingP = noulOf(a, `opening-${tag}`);
    const actedP = noulOf(a, `acted-${tag}`);
    if (openingP === null || actedP === null) continue;

    const opening = openingP >= EMPLOYMENT_NOUL_THRESHOLD;
    const acted = opening && actedP >= EMPLOYMENT_NOUL_THRESHOLD;
    let reaction: EmploymentReaction | null = null;
    if (acted) {
      const pick = choiceOf(a, `reaction-${tag}`);
      if (pick === 'receptive' || pick === 'neutral' || pick === 'resistant') {
        reaction = pick;
      }
    }
    out.set(tag, { opening, acted, reaction });
  }
  return out;
}

/**
 * Deterministic-rejection test for the judge call's failure contract:
 * a 4xx from Venice means THIS state can never be judged as-shaped
 * (oversized state, beta wire drift), so the queue must advance - an
 * empty save + stamp, mirroring v1's garbage-parse contract. Without
 * the advance, oldest-first claims would let poison threads
 * permanently occupy the tick's slots. Everything else (network,
 * rate limit - its own kind, 5xx, response parse) is transient: leave
 * the thread for the next tick.
 */
export function isDeterministicRejection(err: unknown): boolean {
  if (!(err instanceof VeniceError)) return false;
  if (err.kind !== 'http') return false;
  const status = err.status ?? 0;
  return status >= 400 && status < 500;
}

interface ClaimRow {
  thread_id: string;
  user_message_count: number;
  active_intent_ids: string[];
  user_id: string;
}

/**
 * One sweep tick: drain up to the cap of settled, intents-active threads.
 * Non-throwing by contract; a per-thread failure logs and yields to the
 * next. Mirrors the bias analyze drain.
 */
export async function runIntentEmploymentSweepTick(admin: SupabaseClient): Promise<void> {
  const apiKey = await readVeniceKey(admin);
  if (!apiKey) return; // no Venice key configured

  const holderId = crypto.randomUUID();
  for (let i = 0; i < INTENT_EMPLOYMENT_SWEEP_CAP; i++) {
    let claim: ClaimRow | null;
    try {
      const { data, error } = await admin.rpc('intent_employment_claim_next_thread', {
        p_holder_id: holderId,
        p_ttl_seconds: INTENT_EMPLOYMENT_CLAIM_TTL_SECONDS,
        p_min_user_messages: INTENT_EMPLOYMENT_MIN_USER_MESSAGES,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      claim = row && typeof row.thread_id === 'string' ? (row as ClaimRow) : null;
    } catch (err) {
      console.error(
        '[intent-employment-sweep] claim failed:',
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
    if (!claim) break; // queue dry

    const log = createEdgeLogger(claim.user_id, 'intent-employment');
    try {
      await employmentForThread(admin, apiKey, claim, holderId, log);
    } catch (err) {
      log.warn(
        `employment pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await log.flush();
    }
  }
}

async function employmentForThread(
  admin: SupabaseClient,
  apiKey: string,
  claim: ClaimRow,
  holderId: string,
  log: EdgeLogger,
): Promise<void> {
  // Resolve the snapshot ids to intents that STILL exist (one may have
  // been retired-and-deleted since the turn). An intent_employments row
  // FK-references intents, so only judge live ones. Ordered by id so
  // the e1..eN tags are deterministic.
  const { data: intentRows, error: intentsErr } = await admin
    .from('intents')
    .select('id, statement')
    .eq('user_id', claim.user_id)
    .in('id', claim.active_intent_ids)
    .order('id');
  if (intentsErr) throw new Error(`reading intents failed: ${intentsErr.message}`);

  const intents: EmploymentIntent[] = (intentRows ?? []).map((r, idx) => ({
    tag: `e${idx + 1}`,
    id: r.id as string,
    statement: r.statement as string,
  }));

  // Nothing live to judge - save an empty set so the claim is released
  // and the thread is stamped processed (advances the queue).
  if (intents.length === 0) {
    await saveEmployments(admin, claim, holderId, [], log);
    return;
  }

  const judged = intents.slice(0, DECISION_ITEM_CAP);
  if (judged.length < intents.length) {
    log.info(
      `intent cap: judging first ${judged.length} of ${intents.length} active intents`,
    );
  }

  const slice = await loadThreadSlice(admin, claim.thread_id);
  if (slice.length === 0) {
    await saveEmployments(admin, claim, holderId, [], log);
    return;
  }

  const transcript = serializeTranscript(trimToCharBudget(slice, EMPLOYMENT_STATE_BUDGET_CHARS));
  log.debug(`employment state: ${transcript.length} chars serialized`);

  let payload: unknown;
  try {
    payload = await veniceDecision({
      apiKey,
      body: buildEmploymentRequest(judged, transcript),
      signal: AbortSignal.timeout(DECISION_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    if (isDeterministicRejection(err)) {
      // This thread can never be judged as-shaped: advance the queue
      // with an empty set (v1's garbage-parse contract) instead of
      // wedging the oldest-first claim order.
      log.warn(
        `judge rejected deterministically (${err instanceof VeniceError ? err.status : '?'}); ` +
          'advancing with an empty set',
      );
      await saveEmployments(admin, claim, holderId, [], log);
      return;
    }
    // Transient failure: do NOT stamp processed - leave the thread for
    // the next tick rather than recording nothing as if judged.
    log.info(`judge decision failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  log.debug(
    `decision usage: ${JSON.stringify((payload as { usage?: unknown })?.usage ?? null)}`,
  );
  log.debug(
    `decision answers: ${JSON.stringify((payload as { answers?: unknown })?.answers ?? null)?.slice(0, 2000)}`,
  );
  // The per-tag digest at info: this IS the sweep's decision - what
  // the judge said about each intent - so the default-level drawer
  // tells the story without opening the debug tap.
  const digest = judged
    .map((i) => {
      const op = noulOf(answers, `opening-${i.tag}`);
      const ap = noulOf(answers, `acted-${i.tag}`);
      const pick = choiceOf(answers, `reaction-${i.tag}`);
      return `${i.tag}: opening ${op?.toFixed(2) ?? '-'} / acted ${ap?.toFixed(2) ?? '-'} / ${pick ?? 'no reaction'}`;
    })
    .join(' | ');
  log.info(`employment judge: ${digest}`);

  const verdicts = parseEmploymentVerdicts(payload, new Set(judged.map((i) => i.tag)));
  const employments = judged
    .map((i) => {
      const v = verdicts.get(i.tag);
      if (!v) return null;
      return {
        intent_id: i.id,
        opening: v.opening,
        acted: v.acted,
        user_reaction: v.reaction,
        // v2 writes no reasoning: telemetry with zero readers, the
        // column is NOT NULL - an empty string flows through the save
        // RPC verbatim. See docs/dev/in-progress/intents.md.
        reasoning: '',
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  await saveEmployments(admin, claim, holderId, employments, log);
  log.info(`recorded ${employments.length} employment row(s) for thread ${claim.thread_id}`);
}

async function saveEmployments(
  admin: SupabaseClient,
  claim: ClaimRow,
  holderId: string,
  employments: ReadonlyArray<{
    intent_id: string;
    opening: boolean;
    acted: boolean;
    user_reaction: EmploymentReaction | null;
    reasoning: string;
  }>,
  log: EdgeLogger,
): Promise<void> {
  const { data, error } = await admin.rpc('intent_employment_save', {
    p_thread_id: claim.thread_id,
    p_holder_id: holderId,
    p_expected_msg_count: claim.user_message_count,
    p_employments: employments,
    p_user_id: claim.user_id,
  });
  if (error) {
    log.warn(`employment save failed: ${error.message}`);
    return;
  }
  if (data === false) {
    log.debug('employment save rejected (claim lost or message count drifted); will re-eligible');
  }
}

export const __test = {
  INTENT_EMPLOYMENT_MODEL,
  EMPLOYMENT_NOUL_THRESHOLD,
  DECISION_ITEM_CAP,
  EMPLOYMENT_STATE_BUDGET_CHARS,
  buildEmploymentRequest,
  parseEmploymentVerdicts,
  serializeTranscript,
  isDeterministicRejection,
};
