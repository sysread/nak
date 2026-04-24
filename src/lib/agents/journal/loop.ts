/**
 * Single-cycle driver for the journaling worker. Parallels
 * `../reflection/loop.ts`: acquire lease -> claim thread -> run agent
 * -> mark pointer. Separate state machine from reflection because the
 * two journal independent things (memories vs daily entries) and can
 * run concurrently against the same threads.
 */
import type { Agent } from '../types';
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import type { JournalInput, JournalOutput } from './types';
import { createLogger } from '../../logger.svelte';
import { todayInZone } from '../../journal-day';

const log = createLogger('journal-worker');

export type CycleResult =
  | 'acquired-lease'
  | 'polling'
  | 'empty-queue'
  | 'journaled'
  | 'claim-lost'
  | 'error';

export interface CycleContext {
  agent: Agent<JournalInput, JournalOutput>;
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * IANA timezone stamp on every entry_date computation. May be null
   * (user hasn't set a preference); the helper falls back to whatever
   * the worker's runtime reports in that case.
   */
  timezone: string | null;
  threadClaimTtlSeconds: number;
  signal: AbortSignal;
  onLeaseLost: () => void;
}

export async function runOneCycle(ctx: CycleContext): Promise<CycleResult> {
  if (ctx.signal.aborted) return 'empty-queue';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) return 'polling';
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    return 'acquired-lease';
  }

  let claim: { threadId: string; terminalMsgId: string } | null = null;
  try {
    claim = await ctx.supabase.claimNextThreadForJournal(
      ctx.holderId,
      ctx.threadClaimTtlSeconds
    );
  } catch {
    return 'error';
  }
  if (!claim) return 'empty-queue';

  log.info(`picked up thread ${claim.threadId} @ msg ${claim.terminalMsgId}`);

  // Compute today's date EVERY cycle rather than cache once per worker
  // run - a worker that stays idle across midnight would otherwise keep
  // writing yesterday's entry. The cost is three Intl calls per claim;
  // negligible.
  const entryDate = todayInZone(ctx.timezone);

  let runResult;
  try {
    runResult = await ctx.agent.run({
      input: {
        threadId: claim.threadId,
        terminalMsgId: claim.terminalMsgId,
        entryDate,
      },
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

  if (runResult.stoppedReason === 'aborted') return 'empty-queue';

  if (runResult.stoppedReason === 'error') {
    log.debug(
      `thread ${claim.threadId} agent reported error`,
      runResult.error ?? '(no message)'
    );
    return 'error';
  }

  // Mark even when no tool call fired. The prompt allows the agent to
  // skip the upsert when the conversation has nothing reflective; in
  // that case we still want the pointer to advance so we don't
  // reconsider the same messages next cycle.
  try {
    const marked = await ctx.supabase.markThreadJournaledIfClaimed(
      claim.threadId,
      ctx.holderId,
      claim.terminalMsgId
    );
    if (marked) {
      log.info(
        `finished thread ${claim.threadId} ` +
          `(wrote=${runResult.output.entryWritten}, ` +
          `${runResult.toolCalls} tool calls over ${runResult.output.inputMessageCount} messages)`
      );
    } else {
      log.debug(
        `claim lost on thread ${claim.threadId} - another device took over`
      );
    }
    return marked ? 'journaled' : 'claim-lost';
  } catch (err) {
    log.debug(
      `mark RPC threw for thread ${claim.threadId}`,
      err instanceof Error ? err.message : String(err)
    );
    return 'error';
  }
}

export interface NapConfig {
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
}

export function napForResult(result: CycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
    case 'journaled':
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
