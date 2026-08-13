// Thread-rechunk work unit.
//
// Keeps public.thread_chunks in step with a growing thread: claim a
// thread whose newest message is past `last_chunked_msg_id`, render its
// messages to a transcript, slice that into embedding-sized chunks, and
// replace the thread's chunk rows. The embed backfill picks the new
// rows up from there (EMBED_SOURCES entry 'thread-chunks').
//
// This is the only curation unit that makes NO model call - it is pure
// text processing plus one write - so it is cheap enough to ride the
// chat-turn tail without a Venice budget concern.
//
// Two drivers share the run half, same shape as ./summary.ts:
// rechunkOneThread (per-user claim from the turn tail) and
// sweepClaimAndRechunk (cross-user claim from the hourly sweep). Both
// are best-effort and non-throwing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import {
  CHUNK_RENDER_VERSION,
  chunkTranscript,
  type TranscriptMessage,
} from '../../_shared/thread-transcript.ts';
import { CURATION_CLAIM_TTL_SECONDS } from './_curation_helpers.ts';

/** Outcome of one rechunk cycle, mirroring the other curation units' vocabulary. */
export type RechunkOutcome =
  /** No claimable thread - everything is chunked, claimed, or ineligible. */
  | 'empty-queue'
  /** Claimed, chunked, saved. The queue may hold more rows. */
  | 'rechunked'
  /** The save RPC returned false - another run took over mid-rechunk. */
  | 'claim-lost'
  /** Supabase errored during the cycle. */
  | 'error';

/**
 * Load every message in the thread, oldest first.
 *
 * Deliberately unbounded, unlike the curation slice loader: chunking is
 * the one consumer that must see the WHOLE thread, because the point of
 * the feature is that the first message of a 107-message thread stays
 * findable. A message cap here would recreate the exact blind spot
 * chunking exists to remove. Size is bounded downstream instead - each
 * chunk is capped, and the chunk count simply grows with the thread.
 */
async function loadThreadMessages(
  adminClient: SupabaseClient,
  threadId: string,
): Promise<TranscriptMessage[]> {
  // RLS OFF: the caller validated thread ownership by claiming the row,
  // and messages inherit ownership from their thread.
  const { data, error } = await adminClient
    .from('messages')
    .select('id, role, content, tool_calls, name')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listMessages failed: ${error.message}`);
  return (data ?? []) as TranscriptMessage[];
}

/**
 * The run half shared by both drivers: the caller already holds the
 * per-thread claim; this rebuilds the chunk rows and saves them.
 * Non-throwing - every failure folds into an outcome the drain loop in
 * ./curation.ts can act on.
 */
async function rechunkClaimedThread(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  holderId: string,
  threadId: string,
  terminalMsgId: string,
): Promise<RechunkOutcome> {
  let chunks: ReturnType<typeof chunkTranscript>;
  try {
    const messages = await loadThreadMessages(adminClient, threadId);
    chunks = chunkTranscript(messages);
  } catch (err) {
    log.debug(
      `thread ${threadId} rechunk failed`,
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }

  try {
    // An empty chunk list is a legitimate save, not a skip: a thread
    // whose messages were all deleted should end up with zero chunk
    // rows, and stamping last_chunked_msg_id is what stops it being
    // re-claimed on every tick forever.
    const { data: saved, error } = await adminClient.rpc('save_thread_chunks_if_claimed', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_msg_id: terminalMsgId,
      p_user_id: userId,
      p_render_version: CHUNK_RENDER_VERSION,
      p_chunks: chunks.map((c) => ({
        index: c.index,
        text: c.text,
        start_msg_id: c.startMsgId,
        end_msg_id: c.endMsgId,
      })),
    });
    if (error) throw new Error(error.message);
    if (saved === true) {
      log.info(`rechunked thread ${threadId} (${chunks.length} chunk(s))`);
      return 'rechunked';
    }
    log.debug(`claim lost on thread ${threadId} - another run took over mid-rechunk`);
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
 * Run one rechunk cycle for `userId`: claim the freshest thread whose
 * chunks are behind its messages and rebuild them. Fired from the
 * chat-turn curation tail (./curation.ts), which owns the logger and
 * its flush. Non-throwing.
 */
export async function rechunkOneThread(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<RechunkOutcome> {
  const holderId = crypto.randomUUID();
  let claim: { thread_id?: unknown; terminal_msg_id?: unknown } | null;
  try {
    const { data, error } = await adminClient.rpc('claim_next_thread_for_rechunk', {
      p_holder_id: holderId,
      p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS,
      p_user_id: userId,
      p_render_version: CHUNK_RENDER_VERSION,
    });
    if (error) throw new Error(`claim_next_thread_for_rechunk failed: ${error.message}`);
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log.error('rechunk claim failed', err instanceof Error ? err : new Error(String(err)));
    return 'error';
  }
  if (!claim || typeof claim.thread_id !== 'string') return 'empty-queue';
  return await rechunkClaimedThread(
    adminClient,
    userId,
    log,
    holderId,
    claim.thread_id,
    claim.terminal_msg_id as string,
  );
}

/**
 * One sweep step: claim the freshest rechunk-eligible thread across ALL
 * users (SECURITY DEFINER claim) and rebuild it. Driven by
 * runCurationSweepTick in ./curation.ts. The logger exists only once a
 * claim lands - the claim is what says whose drawer the lines belong
 * in - and is flushed here because each claim may belong to a
 * different user. Non-throwing.
 */
export async function sweepClaimAndRechunk(
  adminClient: SupabaseClient,
): Promise<RechunkOutcome> {
  const holderId = crypto.randomUUID();
  let claim: { thread_id?: unknown; terminal_msg_id?: unknown; user_id?: unknown } | null;
  try {
    const { data, error } = await adminClient.rpc('claim_next_thread_for_rechunk_sweep', {
      p_holder_id: holderId,
      p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS,
      p_render_version: CHUNK_RENDER_VERSION,
    });
    if (error) {
      throw new Error(`claim_next_thread_for_rechunk_sweep failed: ${error.message}`);
    }
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[rechunk-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
  if (!claim || typeof claim.thread_id !== 'string' || typeof claim.user_id !== 'string') {
    return 'empty-queue';
  }

  const log = createEdgeLogger(claim.user_id, 'rechunk');
  try {
    return await rechunkClaimedThread(
      adminClient,
      claim.user_id,
      log,
      holderId,
      claim.thread_id,
      claim.terminal_msg_id as string,
    );
  } finally {
    // Flush before the sweep moves on so the outcome line isn't dropped
    // as an un-awaited broadcast when the tick settles.
    await log.flush();
  }
}
