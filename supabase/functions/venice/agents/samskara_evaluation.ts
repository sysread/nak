// Samskara evaluation sweep - the next-day retrospective judge.
//
// This is the relevance-gated replacement for the live reaction
// classifier. Where the old classifier resolved only the ~4% of
// cohorts that happened to get a follow-up inside a 1-10 minute
// window, this sweep waits until a conversation has SETTLED (same
// next-day + >= 2 user-round gate as reflection) and then judges every
// samskara that FIRED in that conversation against what actually
// happened in it. Firing is the relevance gate: a samskara fires by
// cosine similarity to the turn, so "did this prediction's topic come
// up?" is already answered by "did it fire?" - a prediction whose
// topic never recurred never fires, never gets judged, and is left
// untouched (no wall-clock decay erodes an untested-but-valid claim).
//
// SLICE 1 (this file): SHADOW MODE. The judge runs, records its
// per-samskara verdict on samskara_fires.verdict, and LOGS the health
// delta it WOULD apply - but changes no health and removes nothing.
// This gathers a week of verdicts to calibrate the delta magnitudes
// against the historical live-classifier confirms before the judge is
// given the wheel. Slice 2 flips SHADOW_MODE off, applies the deltas
// via a health RPC (folding in the confirm/disconfirm/confidence
// count-math the fire score still reads), retires the live classifier
// and the wall-clock decay sweep, seeds the bug-killed dead, and adds
// a health=0 reaper. See docs/dev/plans/samskara-decay-relevance-gated-plan.md.
//
// No lease coordinator, fresh per-call holder id, day-late drain shape
// - all identical to ./reflection.ts; see that file's preamble for the
// rationale. The evaluation_* claim columns on threads are independent
// of reflection_* so the two next-day sweeps lease the same threads
// without contending.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { loadThreadSliceUpTo } from './_agent_tools.ts';
import { completeJsonObject } from './_curation_helpers.ts';
import { messageToVenice, type VeniceWireMessage } from './_recall_helpers.ts';

// Mirrors the reflection tier: the judge, like reflection, reads a
// whole settled conversation and reasons over it, so the same
// model fits. Not yet a distinct AGENT_MODELS role - if the judge
// later needs separate tuning, add a 'samskaraEvaluation' role to
// src/lib/models/index.ts and mirror agentModel(...).id here.
const EVALUATION_MODEL = 'deepseek-v4-flash';

// 600s matches the other next-day sweeps (reflection, wiki). A judge
// run is one structured completion over the transcript plus a couple
// of small DB writes - well inside this - but a TTL must comfortably
// exceed the slowest plausible run, since a run that outlives its
// claim always finishes claim-lost and re-evaluates every cycle.
const EVALUATION_CLAIM_TTL_SECONDS = 600;

// JSON-mode output is a tiny id->verdict object, but the model is
// reasoning-capable and may emit a CoT pass; the project-wide 2048
// floor for agent sub-calls keeps finish_reason off 'length'.
const EVALUATION_MAX_TOKENS = 2048;

// Kill switch. While true the judge records verdicts but never writes
// health (the slice-1 shadow phase). False routes each verdict through
// samskara_apply_evaluation, which recomputes health as the
// empirical-Bayes posterior. The four verdicts are hit / full-miss /
// soft-miss / no-evidence; the magnitude falls out of the posterior and
// its population prior, with one hand-chosen knob - the soft-miss weight -
// living in the RPC, not here.
const SHADOW_MODE = false;

// The judge's four-way verdict. The split that matters is between the two
// "fired but didn't hold" outcomes: not-borne-out means the prediction's
// situation actually arose and the predicted tendency simply did not show
// (a soft miss - real evidence against), while not-engaged means the
// situation never really came up (a loose topical fire - no fair test, no
// evidence either way). Collapsing those two is what left health unable to
// discriminate; firing is recall, this verdict is precision.
type VerdictKind = 'held' | 'contradicted' | 'not-borne-out' | 'not-engaged';

const VERDICT_KINDS: readonly VerdictKind[] = [
  'held',
  'contradicted',
  'not-borne-out',
  'not-engaged',
];

function isVerdict(v: unknown): v is VerdictKind {
  return typeof v === 'string' && (VERDICT_KINDS as readonly string[]).includes(v);
}

export type EvaluationCycleResult = {
  outcome:
    | 'no-thread' // day-gated queue empty this tick (the common case)
    | 'evaluated' // judged a thread and marked it done
    | 'no-fires' // claimed thread had no fired samskaras to judge; marked to advance
    | 'empty-slice' // pathological empty transcript; marked to advance
    | 'claim-lost' // claim expired/stolen mid-run; verdicts (if any) stay, cursor not advanced
    | 'error';
  threadId?: string;
  judged?: number;
};

// Standing behavioural predictions are judged against the conversation
// they fired in. Skeptical by construction: the default is
// 'not-engaged', and 'held'/'contradicted' require explicit evidence
// from the transcript. Erring toward not-engaged is the safe bias - it
// keeps the judge from inflating health on weak signal (which, with no
// fast feedback loop, would let the corpus bloat past its cap).
const JUDGE_SYSTEM_PROMPT = [
  'You evaluate standing behavioural predictions about a user against a',
  'conversation they just had. Each prediction is a hypothesis of the',
  'form "in situations like X, the user tends to Y". For each one, decide',
  'how THIS conversation bore on it, using only evidence visible in the',
  'transcript. Be skeptical: when the conversation does not clearly test',
  'a prediction, say so rather than guessing.',
].join('\n');

/**
 * Build the final user turn that lists the fired predictions and asks
 * for a JSON verdict map. Stable short ids (p1, p2, ...) keep the JSON
 * keys clean and map back to samskara ids on the caller side; the model
 * never needs to echo a uuid.
 */
function buildVerdictRequest(predictions: { tag: string; text: string }[]): string {
  const lines = predictions.map((p) => `${p.tag}: ${p.text}`);
  return [
    'Below are predictions that were live during the conversation above.',
    'For EACH one, first ask: did the SITUATION the prediction is about',
    'actually come up in this conversation?',
    '',
    '- If the situation did NOT really come up (the prediction was only',
    '  loosely related to what was discussed), the verdict is',
    '  "not-engaged": there was no fair test of it.',
    '- If the situation DID come up, judge how the user behaved:',
    '  - "held": the user did what the prediction says they tend to do.',
    '  - "contradicted": the user did the OPPOSITE of the prediction.',
    '  - "not-borne-out": the situation arose but the predicted tendency',
    '    simply did not appear - neither clearly confirmed nor clearly',
    '    contradicted, it just did not happen this time.',
    '',
    'Be skeptical and require explicit evidence from the transcript.',
    'DEFAULT to "not-engaged" when you are unsure whether the situation',
    'genuinely came up; reserve held / contradicted / not-borne-out for',
    'when the prediction was actually put to the test.',
    '',
    'Predictions:',
    ...lines,
    '',
    'Respond with ONLY a JSON object mapping every prediction id to its',
    'verdict, e.g. {"p1":"held","p2":"not-engaged"}. Include every id and',
    'use only the four verdict strings above. No other text.',
  ].join('\n');
}

/**
 * Parse the judge's JSON-object reply into a tag->verdict map, keeping
 * only well-formed entries. Defensive by contract: a malformed body, a
 * missing id, or an out-of-enum value drops that prediction silently
 * (it gets no verdict and no delta this cycle) rather than throwing -
 * the sweep is best-effort and a bad completion must not abort the run.
 */
function parseVerdicts(raw: string): Map<string, VerdictKind> {
  const out = new Map<string, VerdictKind>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  // Must be a plain object. An array is valid JSON and Object.entries
  // would happily yield index->value pairs whose values can be valid
  // verdict strings (["held",...]), silently fabricating tags the model
  // never keyed - reject it.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  for (const [tag, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (isVerdict(v)) out.set(tag, v);
  }
  return out;
}

/**
 * One sweep tick: claim the most-overdue evaluation-eligible thread
 * across ALL users and judge it. Cron-driven (nak-samskara-evaluation-
 * sweep). Non-throwing, same contract as runReflectionSweepTick.
 */
export async function runSamskaraEvaluationSweepTick(
  adminClient: SupabaseClient,
): Promise<EvaluationCycleResult> {
  const holderId = crypto.randomUUID();
  let claim: { thread_id?: unknown; terminal_msg_id?: unknown; user_id?: unknown } | null;
  try {
    const { data, error } = await adminClient.rpc(
      'claim_next_thread_for_evaluation_sweep',
      { p_holder_id: holderId, p_ttl_seconds: EVALUATION_CLAIM_TTL_SECONDS },
    );
    if (error) {
      throw new Error(`claim_next_thread_for_evaluation_sweep failed: ${error.message}`);
    }
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[samskara-evaluation-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { outcome: 'error' };
  }
  if (!claim || typeof claim.thread_id !== 'string' || typeof claim.user_id !== 'string') {
    return { outcome: 'no-thread' };
  }

  // The logger exists only from here - a claim is what tells us whose
  // drawer the lines belong in.
  const log = createEdgeLogger(claim.user_id, 'samskara-eval');
  try {
    return await evaluateClaimedThread(
      adminClient,
      claim.user_id,
      log,
      claim.thread_id,
      claim.terminal_msg_id as string,
      holderId,
    );
  } catch (err) {
    log.error(
      'samskara evaluation cycle failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return { outcome: 'error' };
  } finally {
    await log.flush();
  }
}

/**
 * The run half: the caller already holds the per-thread claim. Gather
 * the samskaras that fired in the thread, judge them against the
 * transcript, record verdicts, and mark the thread evaluated. Throws
 * only on infrastructure failure (the tick owns catch/log/flush).
 */
async function evaluateClaimedThread(
  adminClient: SupabaseClient,
  userId: string,
  log: ReturnType<typeof createEdgeLogger>,
  threadId: string,
  terminalMsgId: string,
  holderId: string,
): Promise<EvaluationCycleResult> {
  log.info(`picked up thread ${threadId} @ msg ${terminalMsgId}`);

  // Distinct samskaras that fired anywhere in this thread. Firing is
  // the relevance gate - these are exactly the predictions whose topic
  // came up, and the only ones eligible for a verdict.
  const { data: fireRows, error: firesErr } = await adminClient
    .from('samskara_fires')
    .select('samskara_id')
    .eq('thread_id', threadId)
    .eq('user_id', userId);
  if (firesErr) throw new Error(`reading samskara_fires failed: ${firesErr.message}`);
  const firedIds = [...new Set((fireRows ?? []).map((r) => r.samskara_id as string))];

  if (firedIds.length === 0) {
    // No prediction was tested by this conversation. Mark it evaluated
    // so the queue advances rather than re-claiming the row forever.
    const marked = await markEvaluated(adminClient, threadId, holderId, terminalMsgId, userId);
    log.debug(`thread ${threadId} fired no samskaras; marked to advance the queue`);
    return { outcome: marked ? 'no-fires' : 'claim-lost', threadId };
  }

  const slice = await loadThreadSliceUpTo(adminClient, threadId, terminalMsgId);
  if (slice.length === 0) {
    const marked = await markEvaluated(adminClient, threadId, holderId, terminalMsgId, userId);
    log.debug(`thread ${threadId} had no messages to judge; marked to advance the queue`);
    return { outcome: marked ? 'empty-slice' : 'claim-lost', threadId };
  }

  // Fetch the prediction text for each fired samskara and assign each a
  // stable p-tag for the JSON contract.
  const { data: samskaraRows, error: samErr } = await adminClient
    .from('samskaras')
    .select('id, prediction')
    .in('id', firedIds);
  if (samErr) throw new Error(`reading samskaras failed: ${samErr.message}`);
  const predictions = (samskaraRows ?? [])
    .filter((r) => typeof r.prediction === 'string' && r.prediction.length > 0)
    .map((r, i) => ({ tag: `p${i + 1}`, id: r.id as string, text: r.prediction as string }));

  if (predictions.length === 0) {
    const marked = await markEvaluated(adminClient, threadId, holderId, terminalMsgId, userId);
    log.debug(`thread ${threadId} fired samskaras have no prediction text; marked to advance`);
    return { outcome: marked ? 'no-fires' : 'claim-lost', threadId };
  }

  const apiKey = await readVeniceKey(adminClient);
  if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

  // Same "switch modes" idiom as reflection: the model sees the whole
  // conversation in its native shape, then a final user turn that
  // reframes the task as judgement.
  const convo: VeniceWireMessage[] = slice.map(messageToVenice);
  const messages: VeniceWireMessage[] = [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    ...convo,
    { role: 'user', content: buildVerdictRequest(predictions) },
  ];

  const rawVerdicts = await completeJsonObject({
    apiKey,
    model: EVALUATION_MODEL,
    messages,
    maxTokens: EVALUATION_MAX_TOKENS,
  });
  const verdicts = parseVerdicts(rawVerdicts);

  // Group fired samskaras by the verdict the judge gave them. A
  // prediction the judge omitted or mis-typed gets no verdict (and no
  // health update) this cycle - best-effort; it re-evaluates next time
  // its thread becomes eligible.
  const byVerdict: Record<VerdictKind, string[]> = {
    held: [],
    contradicted: [],
    'not-borne-out': [],
    'not-engaged': [],
  };
  for (const p of predictions) {
    const v = verdicts.get(p.tag);
    if (v) byVerdict[v].push(p.id);
  }

  // Record the verdicts on the fire rows. One update per verdict group,
  // stamping every fire row of each samskara in this thread. was_confirmed
  // is set alongside so the legacy readers of that column - the Health
  // panel's resolution stats, CohortPanel, BiasProfile - keep working now
  // that the live reaction classifier (its former writer) no longer runs.
  // Both miss verdicts map to false (not-borne-out is a soft miss, but it
  // is still "not confirmed" to a boolean reader); not-engaged stays null
  // (untested), the same as before the soft-miss split.
  for (const kind of VERDICT_KINDS) {
    const ids = byVerdict[kind];
    if (ids.length === 0) continue;
    const wasConfirmed = kind === 'held'
      ? true
      : kind === 'not-engaged'
      ? null
      : false;
    const { error: updErr } = await adminClient
      .from('samskara_fires')
      .update({ verdict: kind, was_confirmed: wasConfirmed })
      .eq('thread_id', threadId)
      .eq('user_id', userId)
      .in('samskara_id', ids);
    if (updErr) throw new Error(`recording verdict '${kind}' failed: ${updErr.message}`);
  }

  const judged = VERDICT_KINDS.reduce((n, k) => n + byVerdict[k].length, 0);
  const verdictSummary = VERDICT_KINDS.map((k) => `${k}=${byVerdict[k].length}`).join(' ');

  if (SHADOW_MODE) {
    // Shadow: verdicts are recorded above; health is untouched. The line
    // lets a week of judgements be eyeballed before going live.
    log.info(
      `shadow-judged thread ${threadId}: ${judged}/${predictions.length} predictions; ${verdictSummary}`,
    );
  } else {
    // Live: fold the verdicts into the self-calibrating posterior.
    // samskara_apply_evaluation discounts prior evidence, applies this
    // round's hit / full-miss / soft-miss, and recomputes health =
    // confidence = the posterior shrunk toward the population prior `p0`.
    // The not-engaged ids ride along so their prior evidence is discounted
    // (the forgetting) even though they add no hit or miss.
    const { error: applyErr } = await adminClient.rpc('samskara_apply_evaluation', {
      p_user_id: userId,
      p_held: byVerdict.held,
      p_contradicted: byVerdict.contradicted,
      p_not_borne_out: byVerdict['not-borne-out'],
      p_not_engaged: byVerdict['not-engaged'],
    });
    if (applyErr) throw new Error(`samskara_apply_evaluation failed: ${applyErr.message}`);
    log.info(
      `judged thread ${threadId}: ${judged}/${predictions.length} predictions; ${verdictSummary}`,
    );
  }

  const marked = await markEvaluated(adminClient, threadId, holderId, terminalMsgId, userId);
  if (!marked) {
    // Claim lost mid-run: recorded verdicts stay (they describe a real
    // judgement), but the cursor is not advanced, so the thread
    // re-evaluates next cycle. Matches reflection's claim-lost posture.
    log.warn(`claim lost on thread ${threadId} - cursor not advanced; verdicts recorded stay`);
    return { outcome: 'claim-lost', threadId, judged };
  }
  return { outcome: 'evaluated', threadId, judged };
}

async function markEvaluated(
  adminClient: SupabaseClient,
  threadId: string,
  holderId: string,
  terminalMsgId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await adminClient.rpc('mark_thread_evaluated_if_claimed', {
    p_thread_id: threadId,
    p_holder_id: holderId,
    p_msg_id: terminalMsgId,
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`mark_thread_evaluated_if_claimed failed: ${error.message}`);
  }
  return data === true;
}

// Test-only surface: the verdict parser's defensive drops and the
// prompt contract are behaviour worth pinning without a live Venice call.
export const __test = { parseVerdicts, buildVerdictRequest };
