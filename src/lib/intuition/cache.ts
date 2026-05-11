/**
 * Intuition cache load/save plus a tiny in-memory inflight registry.
 *
 * The persisted payload lives on `threads.intuition_payload` (jsonb).
 * This module owns the read coercion, the write call, and the local
 * "is a refresh already running for this thread?" state - the latter
 * keeps two concurrent triggers (e.g. mood + title both firing in
 * the same chat-loop call) from kicking off a duplicate pipeline.
 *
 * We don't persist the in-flight flag. A page reload mid-pipeline
 * loses the flag, which is correct - the pipeline itself died with
 * the page, so the "in flight" state was never accurate beyond the
 * tab that started it. The next trigger on the next tab refresh
 * just starts a clean run.
 */
import type { SupabaseService, Thread } from '../supabase';
import type { IntuitionPayload } from './types';
import { coerceIntuitionPayload } from './types';
import { createLogger } from '../logger.svelte';

const log = createLogger('intuition');

/**
 * Read the cached payload off the thread row, if any. Drift /
 * unknown-version rows return null so a fresh refresh runs on the
 * next trigger - same posture other jsonb columns in the project
 * use.
 */
export function readIntuitionCache(thread: Thread): IntuitionPayload | null {
  return coerceIntuitionPayload(thread.intuition_payload);
}

/**
 * Persist a freshly-computed payload to the thread row. Writes
 * fire-and-forget from the chat-loop's perspective: a write failure
 * is logged but does NOT abort the response - the in-memory payload
 * is what feeds the conscious agent this turn, so even a Supabase
 * outage just means the next turn starts cold.
 */
export async function writeIntuitionCache(
  supabase: SupabaseService,
  threadId: string,
  payload: IntuitionPayload
): Promise<void> {
  try {
    await supabase.setThreadIntuitionPayload(threadId, payload);
  } catch (err) {
    log.warn('failed to persist intuition payload', err);
  }
}

// Tab-local "is a refresh in flight for this thread?" map. Cleared
// when the run resolves (success or failure). Two near-simultaneous
// triggers in the same tab see the same Promise and settle on the
// same result.
const inflight = new Map<string, Promise<IntuitionPayload | null>>();

/**
 * Register an in-flight pipeline for a thread. If one is already
 * running, return that Promise so the second caller piggybacks on
 * it; otherwise run the producer and stash the Promise. Cleared
 * automatically on settle.
 */
export async function withIntuitionInflight(
  threadId: string,
  producer: () => Promise<IntuitionPayload | null>
): Promise<IntuitionPayload | null> {
  const existing = inflight.get(threadId);
  if (existing) return existing;
  const p = (async () => {
    try {
      return await producer();
    } finally {
      inflight.delete(threadId);
    }
  })();
  inflight.set(threadId, p);
  return p;
}
