/**
 * Shared state + main-thread runner for the deep-sleep memory
 * librarian. Same shape as `wiki-librarian/runner.svelte.ts`:
 *
 * 1. `deepSleepRunner` rune. Two booleans the Memories top-bar reads:
 *    - `workerBusy`: true while the scheduled background worker is in
 *      the middle of an `agent.run()`. Set/cleared by the manager
 *      intercepting `{type:'busy'}` messages from the worker.
 *    - `manualBusy`: true while a main-thread manual run started from
 *      this module is in flight. Set/cleared inside `runManually`.
 *    The UI disables the manual-run button when either is true so a
 *    user-clicked run never collides with the periodic sweep. Note
 *    that the deep-sleep and rem workers share the
 *    'memory-librarian' lease partition, so the lease coordinator
 *    already prevents the two BACKGROUND workers from running
 *    concurrently across devices - this rune adds the in-page guard
 *    for manual runs against the local scheduled worker.
 *
 * 2. `runManually()`. The Memories top-bar's button calls this to
 *    kick off a deep-sleep cycle on the main thread - same
 *    DeepSleepAgent class, same toolbox. Does NOT call
 *    `claim_deep_sleep_run`, so a manual run does not reset the 12h
 *    cadence that gates the scheduled worker.
 *
 * Why main-thread, not "kick the worker": same rationale as
 * wiki-librarian. The worker's loop is idle-driven (polling + lease +
 * atomic claim) and would require a new message-shape plus an out-
 * of-band path around the claim RPC. Running on the main thread is
 * simpler, lighter on the worker protocol, and gives the UI a single
 * Promise to await.
 */
import type { SupabaseService } from '../../supabase';
import { createLogger } from '../../logger.svelte';
import { emitMemoryChange } from '../../memory-events';
import { buildBatchForSeed } from './loop';

const log = createLogger('deep-sleep-worker');

interface RunnerState {
  workerBusy: boolean;
  manualBusy: boolean;
}

const state = $state<RunnerState>({ workerBusy: false, manualBusy: false });

export const deepSleepRunner = {
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

/**
 * Live-progress events the manual runner surfaces to the Memories UI's
 * step list. Same three families as the wiki librarian:
 *
 *   - `preparing`: emitted once, before the agent starts. Carries the
 *     batch size so the UI can render "Loading N memories..." while
 *     the embed + similarity search runs.
 *   - `thinking` / `tool`: forwarded verbatim from
 *     `runHeadlessToolLoop`'s `onProgress` so the same step list can
 *     show both model rounds and tool calls in arrival order.
 *   - `done`: emitted once, after the agent returns. The UI uses this
 *     to settle the trailing pending row's spinner.
 */
export type DeepSleepProgress =
  | { kind: 'preparing'; batchSize: number }
  | { kind: 'thinking'; round: number }
  | { kind: 'tool'; name: string; activity: string; ok: boolean; ms: number }
  | { kind: 'done'; ok: boolean };

export interface RunManuallyOpts {
  supabase: SupabaseService;
  userId: string;
  signal?: AbortSignal;
  onProgress?: (event: DeepSleepProgress) => void;
}

export interface RunManuallyResult {
  kind: 'ok' | 'no-eligible' | 'too-small' | 'error';
  /** The agent's one-or-two-sentence summary (empty on error). */
  finalText: string;
  toolCalls: number;
  batchSize: number;
  /** Human-readable error message when `kind === 'error'`. */
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
      batchSize: 0,
      error: 'A manual deep-sleep run is already in flight.',
    };
  }
  state.manualBusy = true;
  log.info('manual deep-sleep run requested');
  const emit = (event: DeepSleepProgress): void => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress(event);
    } catch {
      // Best-effort - see wiki-librarian/runner.svelte.ts.
    }
  };
  const signal = opts.signal ?? new AbortController().signal;
  try {
    const seed = await opts.supabase.pickDeepSleepSeed();
    if (!seed) {
      log.info('manual deep-sleep: no eligible memories');
      emit({ kind: 'done', ok: true });
      return {
        kind: 'no-eligible',
        finalText: '',
        toolCalls: 0,
        batchSize: 0,
      };
    }

    const batch = await buildBatchForSeed(opts.supabase, seed, signal);
    emit({ kind: 'preparing', batchSize: batch.length });

    if (batch.length < 2) {
      // Same lonely-seed short-circuit as the loop. Mark visited and
      // surface to the UI so the user understands "ran, nothing to
      // do" rather than "ran, agent decided no changes."
      try {
        await opts.supabase.markMemoriesLibrarianVisited([seed.id]);
      } catch (err) {
        log.debug(
          'failed to stamp visit on lonely seed (manual)',
          err instanceof Error ? err.message : String(err)
        );
      }
      emit({ kind: 'done', ok: true });
      return {
        kind: 'too-small',
        finalText: '',
        toolCalls: 0,
        batchSize: batch.length,
      };
    }

    const { DeepSleepAgent } = await import('./agent');
    const agent = new DeepSleepAgent(opts.supabase);
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

    const runResult = await agent.run({
      input: { batch },
      userId: opts.userId,
      signal,
    });

    try {
      await opts.supabase.markMemoriesLibrarianVisited(batch.map((m) => m.id));
    } catch (err) {
      log.debug(
        'failed to stamp visit timestamps on manual batch',
        err instanceof Error ? err.message : String(err)
      );
    }

    const reasoning =
      runResult.output.finalText.replace(/\s+/g, ' ').trim() || '(none)';
    if (runResult.stoppedReason === 'error') {
      log.warn(
        `manual deep-sleep errored: ${runResult.error ?? '(no message)'}`
      );
      emit({ kind: 'done', ok: false });
      return {
        kind: 'error',
        finalText: '',
        toolCalls: runResult.toolCalls,
        batchSize: runResult.output.batchSize,
        error: runResult.error ?? 'Deep-sleep run failed without a message.',
      };
    }
    log.info(
      `manual deep-sleep finished (${runResult.toolCalls} tool calls over ` +
        `${runResult.output.batchSize} memories, reasoning="${reasoning}")`
    );
    // Always emit a memory-change event so an open Memories panel
    // refetches the list - some runs make no edits, but the refetch
    // is cheap and keeps the surface honest when edits did land.
    emitMemoryChange();
    emit({ kind: 'done', ok: true });
    return {
      kind: 'ok',
      finalText: runResult.output.finalText,
      toolCalls: runResult.toolCalls,
      batchSize: runResult.output.batchSize,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`manual deep-sleep run threw: ${msg}`);
    emit({ kind: 'done', ok: false });
    return {
      kind: 'error',
      finalText: '',
      toolCalls: 0,
      batchSize: 0,
      error: msg,
    };
  } finally {
    state.manualBusy = false;
  }
}
