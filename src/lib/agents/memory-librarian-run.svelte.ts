/**
 * Navigation-stable run state for the memory librarian's manual
 * passes (deep-sleep and rem).
 *
 * The Memories panel is unmounted whenever the user switches drawer
 * tabs - Chat.svelte renders it under `{#if drawerTab === 'memories'}`,
 * and Svelte destroys the component on the branch flip. If the live
 * run state lived in the component, navigating away mid-run would
 * discard the progress strip and the result, and a run that finished
 * while the panel was unmounted would leave nothing to show on
 * return. The run itself is already safe across navigation - the
 * `runManually` promise floats on the runner module, not the
 * component, and each `consolidate_memories` call is atomic - but the
 * UI state has to live somewhere that outlives the panel.
 *
 * This singleton is that home. The panel reads `pass / steps /
 * resultLine / resultText / error` and calls `start()`; the whole run
 * lifecycle runs here, so navigating away and back just re-renders
 * the same state. Mirrors how `deepSleepRunner` / `remRunner` already
 * keep `manualBusy` on a module singleton.
 *
 * The confirmation step deliberately stays panel-local: it's pre-run
 * UI with nothing in flight, so losing it on navigation (and
 * re-opening with one click) is fine.
 */
import type { SupabaseService } from '../supabase';
import type { VeniceClient } from '../venice';
import {
  pushStep,
  deepSleepResultLine,
  remResultLine,
  type MemoryLibrarianPass,
  type MemoryLibrarianStep,
} from '../ui/memory-librarian';
import {
  runManually as runDeepSleepManually,
  deepSleepRunner,
} from './deep-sleep/runner.svelte';
import { runManually as runRemManually, remRunner } from './rem/runner.svelte';

interface LibrarianRunState {
  /** Which pass is active or was last shown. Null = strip is clear. */
  pass: MemoryLibrarianPass | null;
  steps: MemoryLibrarianStep[];
  resultLine: string | null;
  resultText: string | null;
  error: string | null;
}

const state = $state<LibrarianRunState>({
  pass: null,
  steps: [],
  resultLine: null,
  resultText: null,
  error: null,
});

interface StartDeps {
  supabase: SupabaseService;
  venice: VeniceClient;
}

export const librarianRun = {
  get pass(): MemoryLibrarianPass | null {
    return state.pass;
  },
  get steps(): MemoryLibrarianStep[] {
    return state.steps;
  },
  get resultLine(): string | null {
    return state.resultLine;
  },
  get resultText(): string | null {
    return state.resultText;
  },
  get error(): string | null {
    return state.error;
  },
  /**
   * True once a run has emitted at least one step or settled into a
   * result/error - i.e. the progress strip should be visible. False
   * before the first step and after `clear()`.
   */
  get active(): boolean {
    return (
      state.pass !== null &&
      (state.steps.length > 0 ||
        state.resultLine !== null ||
        state.error !== null)
    );
  },
  /** True while a manual run (either pass) is mid-flight. */
  get running(): boolean {
    return deepSleepRunner.manualBusy || remRunner.manualBusy;
  },

  /** Clear the strip. The Dismiss button calls this; no-op mid-run. */
  clear(): void {
    if (this.running) return;
    state.pass = null;
    state.steps = [];
    state.resultLine = null;
    state.resultText = null;
    state.error = null;
  },

  /**
   * Kick off a manual pass and stream its progress into this store.
   * Guards against starting while either pass is already busy (the
   * two share a cross-device lease and never run concurrently). The
   * whole lifecycle - session fetch, the runManually call, the
   * result handoff - lives here rather than in the panel so it
   * survives the panel being unmounted mid-run.
   */
  async start(pass: MemoryLibrarianPass, deps: StartDeps): Promise<void> {
    if (deepSleepRunner.busy || remRunner.busy) return;
    state.pass = pass;
    state.steps = [];
    state.resultLine = null;
    state.resultText = null;
    state.error = null;

    let userId: string;
    try {
      const session = await deps.supabase.getSession();
      if (!session) {
        state.error = 'Not signed in.';
        return;
      }
      userId = session.user.id;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      return;
    }

    try {
      if (pass === 'deep-sleep') {
        const result = await runDeepSleepManually({
          supabase: deps.supabase,
          venice: deps.venice,
          userId,
          onProgress: (event) => {
            if (event.kind === 'preparing') {
              pushStep(state.steps, {
                kind: 'deep-sleep-preparing',
                batchSize: event.batchSize,
              });
            } else {
              pushStep(state.steps, event);
            }
          },
        });
        state.resultLine = deepSleepResultLine({
          kind: result.kind,
          batchSize: result.batchSize,
          toolCalls: result.toolCalls,
        });
        if (result.kind === 'error') {
          state.error = result.error ?? 'Deep-sleep run failed.';
        } else if (result.finalText.trim().length > 0) {
          state.resultText = result.finalText.trim();
        }
      } else {
        const result = await runRemManually({
          supabase: deps.supabase,
          venice: deps.venice,
          userId,
          onProgress: (event) => {
            if (event.kind === 'preparing') {
              pushStep(state.steps, {
                kind: 'rem-preparing',
                conversationCount: event.conversationCount,
              });
            } else {
              pushStep(state.steps, event);
            }
          },
        });
        state.resultLine = remResultLine({
          kind: result.kind,
          conversationsProcessed: result.conversationsProcessed,
          toolCalls: result.toolCalls,
        });
        if (result.kind === 'error') {
          state.error = result.error ?? 'Rem run failed.';
        } else if (result.finalText.trim().length > 0) {
          state.resultText = result.finalText.trim();
        }
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
  },
};
