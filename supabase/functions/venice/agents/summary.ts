// Thread-summary work unit (function-side port of
// src/lib/agents/summary/). One summarisation pass per cycle: claim a
// thread whose newest terminal assistant message hasn't been
// summarised, fetch its messages up to that message, append the
// summary instruction as a final user turn, and ask the fast model
// for a 2-3 sentence topical summary. No tool calls - the output IS
// the final text, written back to `threads.summary`.
//
// The summary's only consumer is the embeddings worker, which
// concatenates title + summary as the embedding input. The row is
// human-readable in Supabase but never surfaced in the UI - keep that
// in mind before tuning the prompt for prose style; the audience is
// bge-m3, not a reader.
//
// Two drivers share the run half: summariseOneThread (per-user claim
// from a chat turn's waitUntil tail, via ./curation.ts) and
// sweepClaimAndSummarise (cross-user claim from the hourly curation
// sweep). Both are best-effort and non-throwing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { toolComplete } from '../tools/_venice_complete.ts';
import { loadThreadSliceUpTo } from './_agent_tools.ts';
import {
  completeOverThreadSlice,
  CURATION_CLAIM_TTL_SECONDS,
} from './_curation_helpers.ts';
import { SUMMARY_MODEL } from '../../_shared/agent-models.ts';

/**
 * The summary instruction, appended as the final user turn to a
 * messages array whose prefix IS the original conversation - the
 * model sees itself as the prior assistant, same framing as the
 * reflection agent, for the same reason: the third-party-transcript
 * angle dilutes signal, while the first-person angle keeps the
 * writing focused on what the thread was actually about.
 *
 * Verbatim copy of SUMMARY_PROMPT in src/lib/agents/summary/prompt.ts
 * so the model gets identical guidance whichever path drove it; the
 * literal's em-dashes are preserved to keep the two copies
 * diff-identical (same exception the reflection prompt documents).
 *
 * Format rationale (from the browser original):
 *   - 2-3 sentences, prose not bullets - bge-m3 handles prose more
 *     gracefully than whitespace-heavy formats.
 *   - Topical, not conversational - the subject matter is the signal;
 *     "the user asked and the assistant answered" is the shape every
 *     thread shares.
 *   - Present tense - biases language toward subject matter rather
 *     than narrative.
 *   - No preamble - "Here's a summary:" starts every summary with
 *     tokens that contribute nothing.
 */
const SUMMARY_PROMPT = `You've just finished the conversation above. Step out of that role.
Nobody will read this reply as a chat turn — it's being used as a
search index for this conversation.

Write a 2–3 sentence topical summary of what this conversation is
about. Describe the subject matter — the problem, the domain, the
artifacts discussed — not the shape of the exchange. Present tense.
No preamble, no trailing pleasantries, no hedging, no bullet list.
Just the summary.`;

/**
 * Trim the model's raw output. Strips trailing whitespace, wraps of
 * quote characters some models emit around "direct speech" outputs,
 * and caps length at 600 chars (safely beyond "2-3 sentences" and
 * well under the worst-case token inflation at bge-m3).
 */
function trimSummary(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  return stripped.length > 600 ? stripped.slice(0, 600) : stripped;
}

/** Outcome of one summary cycle, mirroring the browser unit's CycleResult vocabulary. */
export type SummaryOutcome =
  /** No claimable thread - everything is summarised, claimed, or ineligible. */
  | 'empty-queue'
  /** Claimed, summarised, saved. The queue may hold more rows. */
  | 'summarised'
  /**
   * The save RPC returned false - another run took over mid-summary.
   * Not an error; drop the work and drain.
   */
  | 'claim-lost'
  /** Model produced an empty summary - claim left to expire via TTL. */
  | 'empty-summary'
  /** Supabase or Venice errored during the cycle. */
  | 'error';

/**
 * The run half shared by both drivers: the caller already holds the
 * per-thread claim; this summarises the slice and saves the result.
 * Non-throwing - every failure path folds into an outcome the drain
 * loops in ./curation.ts can act on.
 */
async function summariseClaimedThread(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  holderId: string,
  threadId: string,
  terminalMsgId: string,
): Promise<SummaryOutcome> {
  log.info(`picked up thread ${threadId} @ msg ${terminalMsgId}`);

  let summary: string;
  let inputMessageCount: number;
  try {
    // Slicing the history at the claimed terminal message means a race
    // where the user added turns mid-summary simply queues the thread
    // for the next cycle.
    const slice = await loadThreadSliceUpTo(adminClient, threadId, terminalMsgId);
    if (slice.length === 0) {
      // Pathological empty thread - nothing to summarise. Leave the
      // claim to the TTL; the claim predicate requires a terminal
      // assistant message, so an empty slice means the row changed
      // under us and will re-qualify (or not) on its own.
      return 'empty-summary';
    }

    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    // completeOverThreadSlice owns the transcript sizing: message cap,
    // per-row excerpting, token budget, and the shrink-retry on a
    // context-length rejection.
    //
    // Non-streaming call: we only want the final text. 2048 is the
    // project-wide floor on agent sub-call caps; the prompt's 2-3
    // sentence target lands well under that. The prompt controls
    // length, not the cap.
    const { result, messageCount } = await completeOverThreadSlice(
      slice,
      SUMMARY_PROMPT,
      (messages) =>
        toolComplete({
          apiKey,
          model: SUMMARY_MODEL,
          // Background curation agent: ride out a transient 429 rather
          // than failing the summary on one "model overloaded".
          retryRateLimit: true,
          messages,
          maxTokens: 2048,
        }),
    );
    summary = trimSummary(result.text);
    inputMessageCount = messageCount;
  } catch (err) {
    log.debug(
      `thread ${threadId} agent reported error`,
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }

  if (!summary) {
    // Model refused or returned only whitespace. Don't save - saving
    // an empty string would mark the thread "summarised" and never
    // retry. Leaving the claim stamped until TTL means the row gets
    // another chance on the next cycle, which is the right recovery
    // for a transient model misbehavior. Worst case, the TTL expires
    // and a later cycle re-claims and tries again.
    return 'empty-summary';
  }

  try {
    const { data: saved, error } = await adminClient.rpc(
      'save_thread_summary_if_claimed',
      {
        p_thread_id: threadId,
        p_holder_id: holderId,
        p_summary: summary,
        p_msg_id: terminalMsgId,
        p_user_id: userId,
      },
    );
    if (error) throw new Error(error.message);
    if (saved === true) {
      log.info(`finished thread ${threadId} (${inputMessageCount} messages in)`);
      return 'summarised';
    }
    log.debug(
      `claim lost on thread ${threadId} - another run took over mid-summary`,
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
 * Run one summary cycle for `userId`: claim the oldest summary-
 * eligible thread via the per-user RPC and summarise it. Fired from
 * the chat-turn curation tail (./curation.ts), which owns the logger
 * and its flush. Non-throwing.
 */
export async function summariseOneThread(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<SummaryOutcome> {
  // Fresh holder per call - the claim RPC's atomic per-thread
  // claim+TTL is the mutual exclusion. Same no-lease posture as
  // ./reflection.ts.
  const holderId = crypto.randomUUID();
  let claim: { thread_id?: unknown; terminal_msg_id?: unknown } | null;
  try {
    // p_user_id is the b-strict escape hatch: the service-role admin
    // client has no auth.uid(), so the RPC scopes to the thread owner
    // via coalesce(p_user_id, auth.uid()).
    const { data, error } = await adminClient.rpc('claim_next_thread_for_summary', {
      p_holder_id: holderId,
      p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS,
      p_user_id: userId,
    });
    if (error) throw new Error(`claim_next_thread_for_summary failed: ${error.message}`);
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log.error(
      'summary claim failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return 'error';
  }
  if (!claim || typeof claim.thread_id !== 'string') return 'empty-queue';
  return await summariseClaimedThread(
    adminClient,
    userId,
    log,
    holderId,
    claim.thread_id,
    claim.terminal_msg_id as string,
  );
}

/**
 * One sweep step: claim the most-overdue summary-eligible thread
 * across ALL users (SECURITY DEFINER claim) and summarise it. Driven
 * by runCurationSweepTick in ./curation.ts. The logger exists only
 * once a claim lands - a claim is what tells us WHOSE drawer the
 * lines belong in - and is flushed here because each claim may belong
 * to a different user. Non-throwing.
 */
export async function sweepClaimAndSummarise(
  adminClient: SupabaseClient,
): Promise<SummaryOutcome> {
  const holderId = crypto.randomUUID();
  let claim: { thread_id?: unknown; terminal_msg_id?: unknown; user_id?: unknown } | null;
  try {
    const { data, error } = await adminClient.rpc(
      'claim_next_thread_for_summary_sweep',
      { p_holder_id: holderId, p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS },
    );
    if (error) {
      throw new Error(`claim_next_thread_for_summary_sweep failed: ${error.message}`);
    }
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[summary-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
  if (!claim || typeof claim.thread_id !== 'string' || typeof claim.user_id !== 'string') {
    return 'empty-queue';
  }

  const log = createEdgeLogger(claim.user_id, 'summary');
  try {
    return await summariseClaimedThread(
      adminClient,
      claim.user_id,
      log,
      holderId,
      claim.thread_id,
      claim.terminal_msg_id as string,
    );
  } finally {
    // Flush before the sweep moves on so the outcome line isn't
    // dropped as an un-awaited broadcast when the tick settles.
    await log.flush();
  }
}

// Test-only surface: the output trim and the head/tail condense are
// behavior parity with the browser agent (src/lib/agents/summary/)
// and get asserted in supabase/functions/tests/curation.test.ts.
export const __test = { trimSummary };
