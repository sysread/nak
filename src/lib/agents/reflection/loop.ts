/**
 * Single-cycle driver for the reflection worker. Factored out of
 * `./worker.ts` so the state machine is unit-testable without a Web
 * Worker runtime — the Worker entry point is a thin wrapper that
 * calls `runOneCycle` repeatedly until its AbortSignal trips. Shape
 * mirrors `src/lib/embeddings/loop.ts` deliberately; both drivers
 * share the lease-acquire → claim → work → save/mark progression, so
 * anyone reading one file has the other's vocabulary for free.
 *
 * One cycle = one observable state transition. The outer loop in
 * `./worker.ts` maps each result to a sleep via `napForResult`
 * before asking for another cycle. Splitting "what happened" from
 * "how long to wait" keeps the timing policy in one place and lets
 * tests drive the state machine directly without waiting on timers.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { ReflectionInput, ReflectionOutput } from './agent';
import { createLogger } from '../../logger.svelte';

const log = createLogger('reflection-worker');

export type CycleResult =
  /** Just took the lease on this cycle — no work yet, caller should recurse immediately. */
  | 'acquired-lease'
  /** Someone else holds the lease; we're polling until it expires. */
  | 'polling'
  /** Lease held but no thread needs reflection — idle sleep before the next poll. */
  | 'empty-queue'
  /** Claimed, ran the agent, marked the pointer. Drain to the next thread. */
  | 'reflected'
  /**
   * Ran the agent but the mark RPC returned false — another device
   * took over mid-reflection. Any memory_* side effects already
   * landed (memories are owned by the user, not the claim). Not an
   * error; drain to the next thread.
   */
  | 'claim-lost'
  /** Supabase or agent errored during the cycle. Short back-off. */
  | 'error';

export interface CycleContext {
  /**
   * The reflection agent. Receives ReflectionInput, returns an
   * AgentRunResult<ReflectionOutput>. Injected rather than
   * constructed here so tests can drive the cycle with a mock agent
   * whose `run` returns canned results — no need to fake Venice +
   * Supabase jointly just to assert cycle state transitions.
   */
  agent: Agent<ReflectionInput, ReflectionOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * TTL for the per-thread claim stamped by
   * `claim_next_thread_for_reflection`. Generous (minutes) because a
   * reflection can span several Venice round-trips. If the TTL
   * lapses mid-run, the mark RPC returns false and we record the
   * result as 'claim-lost'.
   */
  threadClaimTtlSeconds: number;
  /**
   * User's display timezone (IANA) - threaded through to the claim
   * RPC so the day-gate buckets on the user's calendar. Null falls
   * back to UTC server-side. Same shape as the wiki worker.
   */
  timezone: string | null;
  signal: AbortSignal;
  onLeaseLost: () => void;
}

/**
 * Drive exactly one cycle. The outer loop is just
 * `while (!signal.aborted) { await runOneCycle(...); await sleep(napForResult(...)); }`.
 */
export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'empty-queue';

  // Top of cycle: acquire the lease if we don't have it. Don't
  // heartbeat while polling — nothing to defend.
  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) return 'polling';
    // Heartbeat wiring is idempotent — startHeartbeat replaces any
    // stale callback, so restart-after-loss needs no special casing.
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    return 'acquired-lease';
  }

  // Lease in hand — try to claim a thread.
  let claim: { threadId: string; terminalMsgId: string } | null = null;
  try {
    claim = await ctx.supabase.claimNextThreadForReflection(
      ctx.holderId,
      ctx.threadClaimTtlSeconds,
      ctx.timezone
    );
  } catch {
    // Transient Supabase failure. Bail to the error back-off; the
    // next cycle retries from scratch.
    return 'error';
  }
  if (!claim) return 'empty-queue';

  // Task pickup — one log per claimed thread so the log drawer can
  // surface the worker's activity. Keep the headline on .info (always
  // on) and the specifics on .debug (filter-out-able when not
  // actively debugging).
  log.info(
    `picked up thread ${claim.threadId} @ msg ${claim.terminalMsgId}`
  );

  // Run the agent. The agent itself catches its own errors and
  // returns a well-formed AgentRunResult — we still wrap in a try to
  // defend against a future bug that lets an exception escape.
  let runResult;
  try {
    runResult = await ctx.agent.run({
      input: { threadId: claim.threadId, terminalMsgId: claim.terminalMsgId },
      userId: ctx.userId,
      threadId: claim.threadId,
      signal: ctx.signal,
    });
  } catch (err) {
    log.debug(
      `thread ${claim.threadId} threw unexpectedly`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }

  // An aborted run means the caller is shutting us down — exit the
  // cycle cleanly so the outer loop can notice signal.aborted and
  // stop. Don't bother marking; the TTL on the claim expires on its
  // own, and the next device to take the lease will redo this
  // thread.
  if (runResult.stoppedReason === 'aborted') return 'empty-queue';

  // An agent-captured error still counts as "work attempted" — the
  // claim stays stamped, the TTL will sweep it later, and the next
  // lease holder (or this one, post-backoff) will retry. We don't
  // mark because last_reflected_msg_id is the "definitely done"
  // pointer, and the run didn't definitely complete.
  if (runResult.stoppedReason === 'error') {
    log.debug(
      `thread ${claim.threadId} agent reported error`,
      runResult.error ?? '(no message)'
    );
    return 'error';
  }

  // Attempt to mark. A false return means the claim expired or was
  // stolen between runStart and runEnd — this is `claim-lost`, not
  // an error.
  try {
    const marked = await ctx.supabase.markThreadReflectedIfClaimed(
      claim.threadId,
      ctx.holderId,
      claim.terminalMsgId
    );
    if (marked) {
      log.info(
        `finished thread ${claim.threadId} ` +
          `(${runResult.toolCalls} tool calls over ${runResult.output.inputMessageCount} messages)`
      );
      // Final text is discarded per the prompt ("reply with a single
      // word") but useful breadcrumb when actively debugging —
      // surface it on .debug so a noisy production drawer stays
      // quiet.
      if (runResult.output.finalText.length > 0) {
        log.debug(
          `thread ${claim.threadId} final text`,
          runResult.output.finalText
        );
      }
    } else {
      log.debug(
        `claim lost on thread ${claim.threadId} - ` +
          'another device took over mid-reflection; any memories already written stay'
      );
    }
    return marked ? 'reflected' : 'claim-lost';
  } catch (err) {
    // Mark RPC threw — treat as transient. We don't know whether the
    // server-side update landed or not. Next cycle will re-claim the
    // thread (since last_reflected_msg_id didn't advance) and redo
    // the reflection. Re-reflection is safe: the agent will find
    // its own already-written memories via memory_search and
    // memory_update rather than duplicate.
    log.debug(
      `mark RPC threw for thread ${claim.threadId}`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }
}

/** Tunables the outer loop maps cycle results to sleep durations with. */
export interface NapConfig {
  /** Sleep after 'polling' — we don't hold the lease. */
  leasePollMs: number;
  /** Sleep after 'empty-queue' — we hold the lease but nothing to do. */
  idleIntervalMs: number;
  /** Sleep after 'error' — Supabase or agent transient failure. */
  errorBackoffMs: number;
}

/**
 * Map cycle outcomes to sleep durations. Zero means "run the next
 * cycle immediately" — used for results that represent forward
 * progress (a thread reflected, a lease just acquired) where we
 * want to drain the queue fast.
 */
export function napForResult(result: CycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
    case 'reflected':
    case 'claim-lost':
      return 0;
    case 'polling':
      return config.leasePollMs;
    case 'empty-queue':
      return config.idleIntervalMs;
    case 'error':
      return config.errorBackoffMs;
  }
}
