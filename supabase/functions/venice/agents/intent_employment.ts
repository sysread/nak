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
// Shape mirrors the bias analyze phase: claim the most-overdue settled
// thread whose intent_active_at_turn snapshot is non-empty (intents
// were live during it) cross-user, run one judge over the transcript,
// save under the claim + message-count guard, stamp processed. Gated on
// the intentsEnabled toggle at the claim, so an opted-out user is never
// processed. The pure prompt + parser are pinned by the Deno suite at
// supabase/functions/tests/intent_employment.test.ts via __test.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { toolComplete } from '../tools/_venice_complete.ts';
import { loadThreadSlice, messageToVenice } from './_recall_helpers.ts';
import { INTENT_EMPLOYMENT_MODEL } from '../../_shared/agent-models.ts';
const INTENT_EMPLOYMENT_MAX_TOKENS = 2048;
const INTENT_EMPLOYMENT_CLAIM_TTL_SECONDS = 300;
const INTENT_EMPLOYMENT_MIN_USER_MESSAGES = 2;
// Threads processed per tick - bounds a tick's Venice spend; a backlog
// drains across daily ticks, same discipline as the bias analyze cap.
const INTENT_EMPLOYMENT_SWEEP_CAP = 10;

/**
 * The judge prompt. Deliberately framed as bookkeeping, not evaluation:
 * the model records what happened with each intention, and is told
 * explicitly this is NOT a judgment of whether the intention is good -
 * that read belongs to the efficacy loop, which this must never feed.
 */
const INTENT_EMPLOYMENT_PROMPT = `You are reviewing a finished conversation to record, for each of the assistant's standing INTENTIONS, what actually happened with it here. This is bookkeeping about behavior - NOT a judgment of whether the intention is good, working, or worth keeping. Be literal about what you observed; do not infer more than the transcript shows.

You will receive the whole conversation, then a list of the assistant's active intentions, each with a tag. For EACH intention report:
- "opening": did a natural moment to act on this intention actually arise in the conversation? true/false. Do not invent openings that were not there - many turns simply give no occasion for a given intention.
- "acted": did the assistant actually lean on the intention? true/false. Only true if you can point to where it shows in the assistant's replies. If there was no opening, acted is false.
- "reaction": if the assistant acted, how did the user respond to that lean - "receptive" (engaged with it, welcomed it), "resistant" (pushed back, deflected, ignored it), or "neutral" (no clear signal either way)? Use null when the assistant did not act, or there is no signal to read.
- "reasoning": one sentence citing what you saw.

Output ONLY a JSON object, no prose:
{"employments":[{"tag":"e1","opening":true,"acted":true,"reaction":"receptive","reasoning":"..."}]}

Include one entry per intention you can assess. Omit an intention only if you genuinely cannot tell.`;

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
  reasoning: string;
}

/** Render the tagged intention list as the judge's final user turn. */
export function buildEmploymentRequest(intents: readonly EmploymentIntent[]): string {
  const lines = intents.map((i) => `${i.tag}: ${i.statement}`);
  return [
    "The conversation above is finished. For each of the assistant's active intentions below, record what happened with it in this conversation, per the rules. Reply with the JSON object only.",
    '',
    ...lines,
  ].join('\n');
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }
  return trimmed;
}

/**
 * Parse the judge's reply into per-tag verdicts. Transport + validation
 * only: strip a fence, parse, and keep entries whose tag is one we
 * asked about, with coercible opening/acted booleans, a reaction in the
 * allowed set (or null), and a non-empty reasoning. A malformed or
 * unknown-tag entry is dropped (best-effort; it re-evaluates next time
 * the thread is eligible). Returns a Map keyed by tag.
 */
export function parseEmploymentVerdicts(
  raw: string,
  validTags: ReadonlySet<string>,
): Map<string, EmploymentVerdict> {
  const out = new Map<string, EmploymentVerdict>();
  let parsed: { employments?: unknown } | null;
  try {
    const obj = JSON.parse(stripJsonFence(raw));
    parsed = typeof obj === 'object' && obj !== null ? (obj as { employments?: unknown }) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.employments)) return out;

  for (const item of parsed.employments) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const tag = typeof o.tag === 'string' ? o.tag : '';
    if (!validTags.has(tag) || out.has(tag)) continue;

    const reasoning = typeof o.reasoning === 'string' ? o.reasoning.trim() : '';
    if (reasoning.length === 0) continue;

    const opening = o.opening === true;
    // acted can only be true if there was an opening - the prompt says
    // so, but enforce it here too so a sloppy reply can't record an
    // action with no occasion for it.
    const acted = opening && o.acted === true;
    const reaction =
      acted && (o.reaction === 'receptive' || o.reaction === 'neutral' || o.reaction === 'resistant')
        ? (o.reaction as EmploymentReaction)
        : null;

    out.set(tag, { opening, acted, reaction, reasoning });
  }
  return out;
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
  // FK-references intents, so only judge live ones.
  const { data: intentRows, error: intentsErr } = await admin
    .from('intents')
    .select('id, statement')
    .eq('user_id', claim.user_id)
    .in('id', claim.active_intent_ids);
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

  const slice = await loadThreadSlice(admin, claim.thread_id);
  if (slice.length === 0) {
    await saveEmployments(admin, claim, holderId, [], log);
    return;
  }

  const messages = [
    { role: 'system' as const, content: INTENT_EMPLOYMENT_PROMPT },
    ...slice.map(messageToVenice),
    { role: 'user' as const, content: buildEmploymentRequest(intents) },
  ];

  let raw: string;
  try {
    const result = await toolComplete({
      apiKey,
      model: INTENT_EMPLOYMENT_MODEL,
      retryRateLimit: true,
      messages,
      maxTokens: INTENT_EMPLOYMENT_MAX_TOKENS,
    });
    raw = result.text;
  } catch (err) {
    // Completion failure: do NOT stamp processed - leave the thread for
    // the next tick rather than recording nothing as if judged.
    log.info(`judge completion failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const verdicts = parseEmploymentVerdicts(raw, new Set(intents.map((i) => i.tag)));
  const employments = intents
    .map((i) => {
      const v = verdicts.get(i.tag);
      if (!v) return null;
      return {
        intent_id: i.id,
        opening: v.opening,
        acted: v.acted,
        user_reaction: v.reaction,
        reasoning: v.reasoning,
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
  INTENT_EMPLOYMENT_PROMPT,
  INTENT_EMPLOYMENT_MODEL,
  buildEmploymentRequest,
  parseEmploymentVerdicts,
  stripJsonFence,
};
