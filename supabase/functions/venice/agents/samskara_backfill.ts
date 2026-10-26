// Samskara evidence-backfill sweep - the warmup pool worker.
//
// Newly minted claims land QUARANTINED (activated_at null; the fire RPC
// excludes them) so an untested hypothesis can never prime a reply. This
// hourly sweep is what releases them: for each quarantined claim it
// retrieves the historical exchanges that would have fired it (centered
// cosine over substrate query embeddings - the same register and query
// text the live fire path uses, so "would have fired" is an exact
// predicate against the judged-fire population), judges the claim
// against each exchange in its OWN completion (never batched - owner
// decision: separate completions minimize cross-conversation pollution),
// and folds the verdicts into the same tallies the live judge writes,
// at reduced weight, via samskara_apply_backfill. When the claim's
// candidate pool is exhausted (or its budget spent) and history
// genuinely engaged it, the claim activates; history that never engaged
// it pins the claim out of the queue and the existing 45-day probation
// reaper collects it. See docs/dev/in-progress/samskara-backfill-plan.md
// for the full contract and the decision ledger.
//
// The judge deliberately shares the live judge's machinery
// (buildVerdictRequest / parseVerdicts / VerdictKind, EVALUATION_MODEL):
// the M5 validity readout compares backfill verdicts with later live
// verdicts, and that comparison is only meaningful when both sides run
// the same calibrated judge on the same verdict scale.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { completeJsonObjectWithMeta } from './_curation_helpers.ts';
import { messageToVenice, type StoredMessage, type VeniceWireMessage } from './_recall_helpers.ts';
import { EVALUATION_MODEL } from '../../_shared/agent-models.ts';
import { buildVerdictRequest, parseVerdicts, type VerdictKind } from './samskara_evaluation.ts';

// Exchanges judged per claim before the gate runs. Eight top-ranked
// exchanges is enough that a claim with any real historical footprint
// meets at least one genuine test, while capping per-claim spend.
// MUST stay identical to the 8 hardcoded in samskara_apply_backfill's
// gate (schema.sql) and the claim RPC's p_budget default.
const ATTEMPT_BUDGET = 8;

// Claims per hourly tick. Drains 48/day against a measured ~7/day mint
// rate (49 mints/week, docs/dev/samskara.md), so the pool drains ahead
// of formation even with bursts.
const CLAIMS_PER_TICK = 2;

// Must outlive the worst tick (2 claims x 8 completions) so a
// concurrent tick can never claim a row mid-batch.
const CLAIM_TTL_SECONDS = 900;

// Centered-cosine floor for candidate retrieval (substrate-mean
// register - the fire path's). LOW on purpose: the register tops out
// at 0.299 (register note on the fire RPC), so this is a noise gate,
// not a relevance bar - selection is top-k by rank. Re-derive on a
// labeled message-vs-claim probe set before changing.
const CANDIDATE_FLOOR = 0.05;

// Per-completion budget. Single-prediction verdict over a ~3-exchange
// slice: the verdict map is tiny, but max_completion_tokens covers the
// reasoning pass too, so this leaves reasoning headroom over the input
// (the CLAUDE.md sub-completion rule). reasoningEffort 'low' below is
// the other half of that clamp.
const MAX_TOKENS = 2048;

// Framing replaces the live judge's "predictions that were live during
// the conversation above": no live/quarantine/backfill disclosure - a
// provenance hint risks a leniency or harshness anchor, and the claim
// being formulated after the fact is context the judge does not need.
const BACKFILL_FRAMING =
  'Below is a standing prediction about the user. Judge how the conversation above bears on it, using only evidence visible in the transcript.';

// The live judge's skeptical frame, re-worded for a historical
// conversation. The two-step structure itself (engagement gate, then
// outcome) lives in buildVerdictRequest's user turn and is reused
// verbatim - it is calibrated machinery (the 92.5% held-rate incident
// is what its skeptical bias exists for) and must not drift.
const JUDGE_SYSTEM_PROMPT = [
  'You evaluate standing behavioural predictions about a user against',
  'one of their past conversations. Each prediction is a hypothesis of',
  'the form "in situations like X, the user tends to Y". For the',
  'prediction given, decide how THIS conversation bore on it, using',
  'only evidence visible in the transcript. Be skeptical: when the',
  'conversation does not clearly test the prediction, say so rather',
  'than guessing.',
].join('\n');

export type BackfillSweepResult = {
  outcome: 'ok' | 'error';
  claims: number; // claims that made progress this tick
  judged: number; // exchanges judged this tick
};

export async function runSamskaraBackfillSweepTick(
  admin: SupabaseClient,
): Promise<BackfillSweepResult> {
  let claims = 0;
  let judged = 0;
  for (let i = 0; i < CLAIMS_PER_TICK; i++) {
    try {
      const progressed = await tickOneClaim(admin, (n) => (judged += n));
      if (!progressed) break; // queue empty (or transient claim miss)
      claims++;
    } catch (err) {
      // One claim's failure must not burn the tick: log and stop this
      // tick's loop (the next hour retries; the ledger's per-row
      // records plus the claim TTL make every intermediate state
      // recoverable).
      console.error(
        '[samskara-backfill] claim tick failed:',
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
  }
  if (claims > 0 || judged > 0) {
    console.info(`[samskara-backfill] tick done: claims=${claims} judged=${judged}`);
  }
  return { outcome: 'ok', claims, judged };
}

// Process one claimed claim. Returns false when the queue was empty
// (caller stops the loop); true when a claim was picked up and driven
// to its gate.
async function tickOneClaim(
  admin: SupabaseClient,
  onJudged: (n: number) => void,
): Promise<boolean> {
  const holderId = crypto.randomUUID();
  const { data: claimed, error } = await admin.rpc('samskara_claim_quarantined_samskara', {
    p_holder_id: holderId,
    p_ttl_seconds: CLAIM_TTL_SECONDS,
    p_budget: ATTEMPT_BUDGET,
  });
  if (error) {
    console.error('[samskara-backfill] claim rpc failed:', error.message);
    return false;
  }
  const row = (Array.isArray(claimed) ? claimed[0] : claimed) as {
    id: string;
    user_id: string;
    prediction: string;
  } | null;
  if (!row) return false;
  const log = createEdgeLogger(row.user_id, 'samskara-backfill');
  log.debug(`claimed quarantined claim ${row.id}`);

  const apiKey = await readVeniceKey(admin);
  if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

  const { data: candData, error: candErr } = await admin.rpc('samskara_backfill_candidates', {
    p_samskara_id: row.id,
    p_k: ATTEMPT_BUDGET,
    p_user_id: row.user_id,
    p_floor: CANDIDATE_FLOOR,
  });
  if (candErr) throw new Error(`candidates rpc failed: ${candErr.message}`);
  const candidates = (candData ?? []) as {
    thread_id: string;
    user_message_id: string;
    assistant_message_id: string | null;
    cosine: number;
  }[];

  const poolExhausted = candidates.length === 0 || candidates.length < ATTEMPT_BUDGET;

  // Empty-corpus exception (transition 2): no substrate rounds exist
  // outside the birthplace AT ALL - checked by round existence with a
  // live user message, NOT by embedding state (the embedding poll lags
  // the deploy, and keying on embeddings would mass-activate early
  // mints). Quarantine against a corpus that has nothing to judge
  // against is indefinite starvation; the live judge is the only
  // signal there anyway. A non-empty pool that happens to return few
  // candidates is exhaustion, not emptiness - that path goes through
  // the gate below.
  if (candidates.length === 0 && !(await hasEligibleRounds(admin, row))) {
    await admin
      .from('samskaras')
      .update({ activated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('activated_at', 'null');
    log.debug(`backfill: claim ${row.id} activated on empty corpus`);
    return true;
  }

  // Judge each candidate in its own completion. Ledger row FIRST
  // (crash-retry exclusion keys on the ledger, so a crash between
  // insert and fold never re-judges an exchange), verdicts folded in
  // one batch afterwards. A Venice error or truncated completion on
  // one candidate skips that exchange (unledgered, so it is eligible
  // again next tick) and continues with the rest.
  const ledgerIds: Record<VerdictKind, string[]> = {
    held: [],
    contradicted: [],
    'not-borne-out': [],
    'not-engaged': [],
  };
  let judged = 0;
  for (const cand of candidates) {
    const slice = await loadExchangeSlice(admin, cand.thread_id, cand.user_message_id);
    if (!slice) continue; // message deleted since retrieval; skip
    const verdict = await judgeExchange(apiKey, row.prediction, slice);
    if (!verdict) continue;
    const inserted = await admin
      .from('samskara_backfill_verdicts')
      .upsert(
        {
          user_id: row.user_id,
          samskara_id: row.id,
          thread_id: cand.thread_id,
          user_message_id: cand.user_message_id,
          verdict,
          cosine: cand.cosine,
          model: EVALUATION_MODEL,
        },
        { onConflict: 'samskara_id,user_message_id', ignoreDuplicates: true },
      )
      .select('id');
    // ignoreDuplicates returns nothing for an already-ledgered pair -
    // count only NEW rows so attempts never double-advance.
    for (const r of inserted.data ?? []) {
      ledgerIds[verdict].push(r.id as string);
      judged++;
    }
  }
  onJudged(judged);

  // Fold + gate, atomically inside the claim guard. The fold RPC
  // releases the claim, advances attempts by every judged exchange,
  // and - when the pool is exhausted or the budget is spent - either
  // activates (ledger shows >= 1 genuine verdict) or pins the row out
  // of the queue (never engaged; the 45-day reaper collects it).
  const { error: foldErr } = await admin.rpc('samskara_apply_backfill', {
    p_user_id: row.user_id,
    p_samskara_id: row.id,
    p_held: ledgerIds.held,
    p_contradicted: ledgerIds.contradicted,
    p_not_borne_out: ledgerIds['not-borne-out'],
    p_not_engaged_count: ledgerIds['not-engaged'].length,
    p_claim_holder: holderId,
    p_weight: 0.5,
    p_pool_exhausted: poolExhausted,
  });
  if (foldErr) throw new Error(`fold rpc failed: ${foldErr.message}`);
  return true;
}

// Does the user have ANY substrate round outside the claim's birthplace
// whose user message still exists? The birthplace set resolves BOTH
// provenance paths ('substrate' ref_id is a substrate id; 'association'
// ref_id is an association id whose a_id/b_id point into substrate).
async function hasEligibleRounds(
  admin: SupabaseClient,
  claim: { id: string; user_id: string },
): Promise<boolean> {
  const { data: prov, error } = await admin
    .from('samskara_provenance')
    .select('kind, ref_id')
    .eq('samskara_id', claim.id);
  if (error) throw new Error(`provenance read failed: ${error.message}`);
  const substrateIds: string[] = [];
  const assocIds: string[] = [];
  for (const p of prov ?? []) {
    (p.kind === 'substrate' ? substrateIds : assocIds).push(p.ref_id as string);
  }
  const birthThreads = new Set<string>();
  if (substrateIds.length > 0) {
    const { data } = await admin
      .from('samskara_substrate')
      .select('thread_id')
      .in('id', substrateIds);
    for (const r of data ?? []) birthThreads.add(r.thread_id as string);
  }
  if (assocIds.length > 0) {
    const { data } = await admin
      .from('samskara_associations')
      .select('a_id, b_id')
      .in('id', assocIds);
    const subIds = (data ?? []).flatMap((a) => [a.a_id as string, a.b_id as string]);
    if (subIds.length > 0) {
      const { data: rows } = await admin
        .from('samskara_substrate')
        .select('thread_id')
        .in('id', subIds);
      for (const r of rows ?? []) birthThreads.add(r.thread_id as string);
    }
  }

  let q = admin
    .from('samskara_substrate')
    .select('user_message_id')
    .eq('user_id', claim.user_id)
    .limit(20);
  if (birthThreads.size > 0) q = q.not('thread_id', 'in', [...birthThreads]);
  const { data: rounds, error: rErr } = await q;
  if (rErr) throw new Error(`substrate read failed: ${rErr.message}`);
  if (!rounds || rounds.length === 0) return false;
  // A round only counts if its user message still exists (soft
  // pointers survive deletion; the candidate retrieval would exclude
  // it anyway, so a round with a dead pointer is not "history").
  const { data: live, error: mErr } = await admin
    .from('messages')
    .select('id')
    .in(
      'id',
      rounds.map((r) => r.user_message_id as string),
    )
    .limit(1);
  if (mErr) throw new Error(`message read failed: ${mErr.message}`);
  return (live?.length ?? 0) > 0;
}

// The exchange slice: the target round's user message + assistant reply,
// plus the adjacent exchange on each side for context. The judge's
// "pointable moment" standard needs a quotable transcript; whole threads
// would multiply tokens for marginal evidence. Returns null when the
// target user message is gone (deleted between retrieval and fetch).
async function loadExchangeSlice(
  admin: SupabaseClient,
  threadId: string,
  userMessageId: string,
): Promise<StoredMessage[] | null> {
  // thread_transcript: position-ordered and fork-resolving - the same
  // transcript order the live judge reads. Never re-sort by created_at:
  // position restarts per fork segment, so wall-clock ordering would mix
  // inherited rows into the slice.
  const { data, error } = await admin
    .rpc('thread_transcript', { p_thread_id: threadId })
    .select('id, thread_id, role, content, tool_calls, tool_call_id, name');
  if (error) throw new Error(`thread transcript read failed: ${error.message}`);
  const msgs = (data ?? []) as StoredMessage[];
  const tIdx = msgs.findIndex((m) => m.id === userMessageId && m.role === 'user');
  if (tIdx < 0) return null;
  const userIdxs = msgs.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const ui = userIdxs.indexOf(tIdx);
  // [previous user message .. the one after the next user message]:
  // target exchange plus at most one exchange on each side.
  const start = ui > 0 ? userIdxs[ui - 1] : 0;
  const end = ui + 2 < userIdxs.length ? userIdxs[ui + 2] : msgs.length;
  return msgs.slice(start, end);
}

// One structured completion over the slice. Returns null on transport
// failure or truncation - the exchange is skipped (unledgered) rather
// than judged from a cut-off or failed completion.
async function judgeExchange(
  apiKey: string,
  prediction: string,
  slice: StoredMessage[],
): Promise<VerdictKind | null> {
  const messages: VeniceWireMessage[] = [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    ...slice.map(messageToVenice),
    {
      role: 'user',
      content: buildVerdictRequest([{ tag: 'p1', text: prediction }], BACKFILL_FRAMING),
    },
  ];
  try {
    const { content, finishReason } = await completeJsonObjectWithMeta({
      apiKey,
      model: EVALUATION_MODEL,
      messages,
      maxTokens: MAX_TOKENS,
      reasoningEffort: 'low',
    });
    if (finishReason === 'length') {
      console.error('[samskara-backfill] judge completion truncated (finish_reason=length)');
      return null;
    }
    const parsed = parseVerdicts(content);
    return parsed.get('p1') ?? null;
  } catch (err) {
    console.error(
      '[samskara-backfill] judge completion failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
