/**
 * Shared state + main-thread runner for the rem memory librarian.
 * Mirror of `deep-sleep/runner.svelte.ts` - the two librarians have
 * separate runners so the Memories top-bar can disable each button
 * independently. They share the 'memory-librarian' lease across the
 * scheduled workers, but the manual paths are separately tracked
 * because a manual deep-sleep run shouldn't disable the manual rem
 * button (and vice versa - the two operations don't conflict at
 * the main-thread level; the only shared state on the main thread
 * is supabase, which is reentrant).
 */
import type { SupabaseService } from '../../supabase';
import type { VeniceClient } from '../../venice';
import { createLogger } from '../../logger.svelte';
import { emitMemoryChange } from '../../memory-events';
import {
  REM_MAX_CONVERSATIONS_PER_CYCLE,
  REM_MIN_BATCH_SIZE,
  type RemMemoryRow,
} from './types';

const log = createLogger('rem-worker');

interface RunnerState {
  workerBusy: boolean;
  manualBusy: boolean;
}

const state = $state<RunnerState>({ workerBusy: false, manualBusy: false });

export const remRunner = {
  get workerBusy(): boolean {
    return state.workerBusy;
  },
  get manualBusy(): boolean {
    return state.manualBusy;
  },
  get busy(): boolean {
    return state.workerBusy || state.manualBusy;
  },
  setWorkerBusy(busy: boolean): void {
    state.workerBusy = busy;
  },
};

export type RemProgress =
  | { kind: 'preparing'; conversationCount: number }
  | { kind: 'thinking'; round: number }
  | { kind: 'tool'; name: string; activity: string; ok: boolean; ms: number }
  | { kind: 'done'; ok: boolean };

export interface RunManuallyOpts {
  supabase: SupabaseService;
  venice: VeniceClient;
  userId: string;
  signal?: AbortSignal;
  onProgress?: (event: RemProgress) => void;
}

export interface RunManuallyResult {
  kind: 'ok' | 'empty-queue' | 'error';
  /** Concatenated agent summaries across processed conversations. */
  finalText: string;
  toolCalls: number;
  conversationsProcessed: number;
  error?: string;
}

export async function runManually(
  opts: RunManuallyOpts
): Promise<RunManuallyResult> {
  if (state.manualBusy) {
    return {
      kind: 'error',
      finalText: '',
      toolCalls: 0,
      conversationsProcessed: 0,
      error: 'A manual rem run is already in flight.',
    };
  }
  state.manualBusy = true;
  log.info('manual rem run requested');
  const emit = (event: RemProgress): void => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress(event);
    } catch {
      // Best-effort.
    }
  };
  const signal = opts.signal ?? new AbortController().signal;
  try {
    const conversationIds = await opts.supabase.pickRemEligibleConversations(
      REM_MAX_CONVERSATIONS_PER_CYCLE
    );
    emit({ kind: 'preparing', conversationCount: conversationIds.length });
    if (conversationIds.length === 0) {
      log.info('manual rem: no eligible conversations');
      emit({ kind: 'done', ok: true });
      return {
        kind: 'empty-queue',
        finalText: '',
        toolCalls: 0,
        conversationsProcessed: 0,
      };
    }

    const { RemAgent } = await import('./agent');
    const agent = new RemAgent(opts.venice, opts.supabase);
    agent.setProgressListener((event) => {
      if (event.kind === 'thinking') {
        emit({ kind: 'thinking', round: event.round });
      } else {
        emit({
          kind: 'tool',
          name: event.name,
          activity: event.activity,
          ok: event.ok,
          ms: event.ms,
        });
      }
    });

    let totalToolCalls = 0;
    let processed = 0;
    const summaries: string[] = [];

    for (const conversationId of conversationIds) {
      if (signal.aborted) break;
      const memories = await opts.supabase.fetchMemoriesForConversation(conversationId);
      if (memories.length < REM_MIN_BATCH_SIZE) {
        try {
          await opts.supabase.markMemoryConversationProcessed(conversationId);
        } catch {
          // Best-effort.
        }
        continue;
      }
      const batch: RemMemoryRow[] = memories.map((m) => ({
        id: m.memory_id,
        label: m.label,
        data: m.data,
        confidence: m.confidence,
      }));
      const runResult = await agent.run({
        input: { conversationId, batch },
        userId: opts.userId,
        signal,
      });
      totalToolCalls += runResult.toolCalls;
      if (runResult.stoppedReason !== 'error') {
        processed++;
        try {
          await opts.supabase.markMemoryConversationProcessed(conversationId);
        } catch {
          // Best-effort.
        }
        const summary = runResult.output.finalText.replace(/\s+/g, ' ').trim();
        if (summary.length > 0) summaries.push(summary);
      }
    }

    if (processed > 0) emitMemoryChange();
    emit({ kind: 'done', ok: true });

    log.info(
      `manual rem finished (${totalToolCalls} tool calls across ${processed} conversation(s))`
    );
    return {
      kind: 'ok',
      finalText: summaries.join(' '),
      toolCalls: totalToolCalls,
      conversationsProcessed: processed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`manual rem run threw: ${msg}`);
    emit({ kind: 'done', ok: false });
    return {
      kind: 'error',
      finalText: '',
      toolCalls: 0,
      conversationsProcessed: 0,
      error: msg,
    };
  } finally {
    state.manualBusy = false;
  }
}
