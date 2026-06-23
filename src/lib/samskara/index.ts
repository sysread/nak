/**
 * Public surface for the samskara feature on the chat-loop side.
 *
 * The chat loop has exactly one client-side integration point and it
 * lives behind this module:
 *
 *   - `recordSubstrateStub(supabase, threadId, msgIds)` — insert the
 *     per-round substrate row at end-of-round. The assimilator phase
 *     of the formation pipeline enriches it later; this call is fast
 *     and LLM-free.
 *
 * Everything heavier - firing the cosine RPC, reading the compound
 * summary, formatting the priming `<think>` blocks - now runs
 * server-side in the venice edge function
 * (supabase/functions/venice/priming/samskara.ts) as part of the
 * pre-turn priming relocation. The browser no longer fires or formats;
 * it only records the per-round substrate stub.
 */
import type { SupabaseService } from '../supabase';
import { createLogger } from '../logger.svelte';

const log = createLogger('samskara');

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
