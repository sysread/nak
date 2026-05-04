/**
 * Context-recall cache load/save plus the in-memory inflight registry.
 *
 * The persisted payload lives on `threads.context_recall_payload`
 * (jsonb). This module owns the read coercion, the write call, and
 * the local "is a refresh already running for this thread?" state -
 * the latter keeps two concurrent triggers (e.g. mood + title both
 * firing in the same chat-loop call) from kicking off a duplicate
 * pipeline.
 *
 * Mirror of src/lib/intuition/cache.ts. Two parallel caches, one per
 * subconscious-priming surface; both ride the same trigger
 * machinery but persist independently because their failure modes
 * and refresh costs are independent.
 */
import type { SupabaseService, Thread } from '../supabase';
import { coerceContextRecallPayload } from './types';
import type { ContextRecallPayload } from './types';
import { createLogger } from '../logger.svelte';

const log = createLogger('context-recall');

/**
 * Read the cached payload off the thread row, if any. Drift /
 * unknown-version rows return null so a fresh refresh runs on the
 * next trigger - same posture intuition uses for its own cache.
 */
export function readContextRecallCache(
  thread: Thread
): ContextRecallPayload | null {
  return coerceContextRecallPayload(thread.context_recall_payload);
}

/**
 * Persist a freshly-computed payload to the thread row. Failures are
 * logged but do NOT abort the response - the in-memory payload is
 * what feeds the conscious agent this turn, so even a Supabase
 * outage just means the next turn starts cold.
 */
export async function writeContextRecallCache(
  supabase: SupabaseService,
  threadId: string,
  payload: ContextRecallPayload
): Promise<void> {
  try {
    await supabase.setThreadContextRecallPayload(threadId, payload);
  } catch (err) {
    log.warn('failed to persist context-recall payload', err);
  }
}

// Tab-local "is a refresh in flight for this thread?" map. Cleared
// when the run resolves (success or failure). Two near-simultaneous
// triggers in the same tab see the same Promise and settle on the
// same result. Distinct from the intuition inflight map - the two
// pipelines run independently, and a context-recall refresh in flight
// shouldn't block an intuition refresh on the same thread (or vice
// versa).
const inflight = new Map<string, Promise<ContextRecallPayload | null>>();

/**
 * Register an in-flight pipeline for a thread. If one is already
 * running, return that Promise so the second caller piggybacks on
 * it; otherwise run the producer and stash the Promise. Cleared
 * automatically on settle.
 */
export async function withContextRecallInflight(
  threadId: string,
  producer: () => Promise<ContextRecallPayload | null>
): Promise<ContextRecallPayload | null> {
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

/** Test hook: clear all in-flight registrations. Production code
 *  should never call this - the natural settle path handles
 *  cleanup. */
export function _clearContextRecallInflightForTests(): void {
  inflight.clear();
}
