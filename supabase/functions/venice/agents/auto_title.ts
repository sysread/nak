// Auto-title work unit (function-side port of src/lib/title-gen.ts +
// src/lib/agents/auto_title/). Names threads still on the
// 'New conversation' placeholder: claim a row, run one non-streaming
// completion over the opening user message, save the sanitised title
// if the claim is still ours.
//
// Why a dedicated single-shot completion rather than letting the main
// model rename via update_title: the main chat-loop's metadata nag
// made the first reply slower and noisier - the rename instruction
// competed with the actual task framing, and a placeholder-titled
// thread would sometimes ship a turn or two before the model got
// around to the tool call. A separate completion against a small fast
// model means the title lands regardless of what the main model is
// busy doing. The chat-loop's round-2+ metadata-message nag remains a
// further fallback when this unit hasn't reached the row yet.
//
// Two drivers share the run half: titleOneThread (per-user claim from
// a chat turn's waitUntil tail, via ./curation.ts curateOnTurnTail)
// and sweepClaimAndTitle (cross-user claim from the hourly curation
// sweep). Both are best-effort and non-throwing - a titling failure
// must never touch the turn's recorded outcome or stall the sweep.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { toolComplete } from '../tools/_venice_complete.ts';
import { sanitizeTitle } from '../tools/_title.ts';
import { CURATION_CLAIM_TTL_SECONDS } from './_curation_helpers.ts';
import { AUTO_TITLE_MODEL } from '../../_shared/agent-models.ts';

// Shared with the other server-side curation agents (summary, topics,
// bias, samskara): a cheap, fast, non-reasoning instruct model. Those
// siblings already run the FULL thread content through this id, while
// auto-title only ever sees the first user message - so isolating
// titling on a separate (e2ee) model bought no real privacy, and one
// shared id keeps the curation family on a single, better-provisioned
// model rather than a small one prone to 429 overload.

/**
 * System prompt for the title-gen sub-call. Short on purpose: the
 * task is bounded and the model just needs to know to emit the
 * title verbatim rather than wrapping it in conversational scaffold.
 * Editing this changes auto-titling on every fresh thread, so
 * treat it as a voice-tuning change.
 */
const TITLE_GEN_SYSTEM_PROMPT = [
  'Read the user message below and return a 3-6 word title for the',
  'conversation it would open. Plain text only: no quotes, no trailing',
  'punctuation, no Markdown formatting (no *, _, backticks, or #), no',
  'preamble. Title-case is fine but not required.',
  'If the message is a greeting or pleasantry, look past it to the',
  'underlying topic the user actually wants to discuss; only fall',
  "back to a generic title (\"Casual chat\", \"Quick question\") when",
  'no topic is recoverable.',
].join('\n');

/**
 * Single-shot title generation from the opening user message. Returns
 * the sanitised title on success, `null` on any failure or empty
 * output - the caller releases the claim on null so the row goes back
 * to the queue and a later cycle retries. Best-effort by contract: a
 * network failure or a Venice 4xx logs one warn line and resolves
 * null rather than throwing.
 */
async function generateThreadTitle(
  apiKey: string,
  userText: string,
  log: EdgeLogger,
): Promise<string | null> {
  const trimmed = userText.trim();
  if (trimmed.length === 0) return null;

  try {
    const result = await toolComplete({
      apiKey,
      model: AUTO_TITLE_MODEL,
      // Background curation agent, no browser rate-limit loop behind it:
      // ride out a transient 429 instead of failing the title (the
      // claim-release-and-retry-next-tick path is the longer backstop).
      retryRateLimit: true,
      messages: [
        { role: 'system', content: TITLE_GEN_SYSTEM_PROMPT },
        { role: 'user', content: trimmed },
      ],
      // Reasoning kill switch: the underlying model is reasoning-
      // capable and would otherwise burn its output budget on a CoT
      // preamble. Bounded task with a tiny answer; we want the title
      // text directly. Same discipline the web_search and
      // research_docs tools use against reasoning models.
      disableThinking: true,
      // Project-wide 2048 floor for agent sub-calls (see commit
      // 21d990d). The earlier 64-token cap here was a regression: it
      // assumed the "3-6 word" prompt + disable_thinking would fully
      // bound the output, but gpt-oss-20b sometimes emits a CoT
      // preamble or ignores the length instruction, and the cap got
      // hit mid-word - threads landed with titles like "troubleshooting
      // the" instead of "Troubleshooting the refrigerator". The prompt
      // is what controls answer length; sanitizeTitle's first-line
      // + 80-char slice is what enforces it on the storage side. The
      // wire cap just needs enough headroom that finish_reason
      // doesn't become 'length' on a chatty completion.
      maxTokens: 2048,
    });
    const title = sanitizeTitle(result.text);
    if (title.length === 0) {
      log.warn('completion produced no usable title');
      return null;
    }
    return title;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`title generation failed: ${detail}`);
    return null;
  }
}

/** Outcome of one auto-title cycle, mirroring the browser unit's CycleResult vocabulary. */
export type AutoTitleOutcome =
  /** No claimable thread - every row is titled, claimed, or ineligible. */
  | 'empty-queue'
  /** Claimed, titled, saved. The queue may hold more rows. */
  | 'titled'
  /**
   * Title generation returned null (model emitted whitespace, network
   * blip, Venice 4xx). Claim is released so the row re-enters the
   * queue immediately; a later cycle retries naturally. Not an error -
   * this is the expected best-effort posture title-gen has always
   * carried.
   */
  | 'no-title'
  /**
   * The save RPC returned false - either the claim was stolen mid-run
   * or the row stopped being eligible (manual rename, model called
   * update_title via the round-2+ nag). Drop the work and drain.
   */
  | 'claim-lost'
  /** Supabase or Venice errored during the cycle. */
  | 'error';

/**
 * The run half shared by both drivers: the caller already holds the
 * per-thread claim; this generates the title and saves-or-clears.
 * Non-throwing - every failure path folds into an outcome the drain
 * loops in ./curation.ts can act on.
 */
async function titleClaimedThread(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  holderId: string,
  threadId: string,
  userText: string,
): Promise<AutoTitleOutcome> {
  log.info(`picked up thread ${threadId}`);

  let apiKey: string | null;
  try {
    apiKey = await readVeniceKey(adminClient);
  } catch {
    apiKey = null;
  }
  if (!apiKey) {
    log.error('no Venice key configured (app_config unseeded)');
    return 'error';
  }

  const title = await generateThreadTitle(apiKey, userText, log);
  if (title === null) {
    // Best-effort: title generation swallowed whatever went wrong
    // (network, 4xx, empty completion) and returned null. Release the
    // claim so the row goes back to the queue immediately; the next
    // cycle will retry naturally.
    try {
      await adminClient.rpc('clear_auto_title_claim', {
        p_thread_id: threadId,
        p_holder_id: holderId,
        p_user_id: userId,
      });
    } catch {
      // Best-effort: if the clear RPC fails, the per-thread claim TTL
      // will let the row re-enter the queue eventually anyway.
    }
    return 'no-title';
  }

  try {
    const { data: saved, error } = await adminClient.rpc(
      'save_thread_title_if_claimed',
      {
        p_thread_id: threadId,
        p_holder_id: holderId,
        p_title: title,
        p_user_id: userId,
      },
    );
    if (error) throw new Error(error.message);
    if (saved === true) {
      log.info(`titled thread ${threadId}: ${title}`);
      return 'titled';
    }
    log.debug(
      `claim lost on thread ${threadId} - ` +
        'either the user renamed manually or the model called update_title mid-flight',
    );
    return 'claim-lost';
  } catch (err) {
    log.debug(
      `save RPC threw for thread ${threadId}`,
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
}

/**
 * Run one auto-title cycle for `userId`: claim the oldest placeholder-
 * titled thread via the per-user RPC and title it. Fired from the
 * chat-turn curation tail (./curation.ts), which owns the logger and
 * its flush. Non-throwing.
 */
export async function titleOneThread(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<AutoTitleOutcome> {
  // Fresh holder per call - the claim RPC's atomic per-thread
  // claim+TTL is the mutual exclusion; nothing else needs to
  // recognise this id. Same no-lease posture as ./reflection.ts.
  const holderId = crypto.randomUUID();
  let claim: { thread_id?: unknown; user_text?: unknown } | null;
  try {
    // p_user_id is the b-strict escape hatch: the service-role admin
    // client has no auth.uid(), so the RPC scopes to the thread owner
    // via coalesce(p_user_id, auth.uid()).
    const { data, error } = await adminClient.rpc('claim_next_thread_for_auto_title', {
      p_holder_id: holderId,
      p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS,
      p_user_id: userId,
    });
    if (error) throw new Error(`claim_next_thread_for_auto_title failed: ${error.message}`);
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log.error(
      'auto-title claim failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return 'error';
  }
  if (!claim || typeof claim.thread_id !== 'string') return 'empty-queue';
  return await titleClaimedThread(
    adminClient,
    userId,
    log,
    holderId,
    claim.thread_id,
    typeof claim.user_text === 'string' ? claim.user_text : '',
  );
}

/**
 * One sweep step: claim the most-overdue placeholder-titled thread
 * across ALL users (SECURITY DEFINER claim) and title it. Driven by
 * runCurationSweepTick in ./curation.ts, which loops this until the
 * queue empties or the per-tick cap hits. The logger exists only once
 * a claim lands - a claim is what tells us WHOSE drawer the lines
 * belong in - and is flushed here because each claim may belong to a
 * different user. Non-throwing.
 */
export async function sweepClaimAndTitle(
  adminClient: SupabaseClient,
): Promise<AutoTitleOutcome> {
  const holderId = crypto.randomUUID();
  let claim: { thread_id?: unknown; user_text?: unknown; user_id?: unknown } | null;
  try {
    const { data, error } = await adminClient.rpc(
      'claim_next_thread_for_auto_title_sweep',
      { p_holder_id: holderId, p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS },
    );
    if (error) {
      throw new Error(`claim_next_thread_for_auto_title_sweep failed: ${error.message}`);
    }
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[auto-title-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
  if (!claim || typeof claim.thread_id !== 'string' || typeof claim.user_id !== 'string') {
    return 'empty-queue';
  }

  const log = createEdgeLogger(claim.user_id, 'auto-title');
  try {
    return await titleClaimedThread(
      adminClient,
      claim.user_id,
      log,
      holderId,
      claim.thread_id,
      typeof claim.user_text === 'string' ? claim.user_text : '',
    );
  } finally {
    // Flush before the sweep moves on so the outcome line isn't
    // dropped as an un-awaited broadcast when the tick settles.
    await log.flush();
  }
}

// Test-only surface: re-exports the shared sanitiser (tools/_title.ts) so
// supabase/functions/tests/curation.test.ts can assert its first-line /
// quote-strip / Markdown-strip / cap / capitalisation rules. update_title
// runs the same function, so these assertions cover both title paths.
export const __test = { sanitizeTitle };
