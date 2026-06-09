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
 * return. The run itself is already safe across navigation - it
 * executes in the venice edge function (the /rem-run and
 * /deep-sleep-run routes), and the awaiting promise floats on this
 * module, not the component - but the UI state has to live somewhere
 * that outlives the panel.
 *
 * This singleton is that home. The panel reads `pass / steps /
 * resultLine / resultText / error` and calls `start()`; the whole run
 * lifecycle runs here, so navigating away and back just re-renders
 * the same state.
 *
 * Transport: the same subscribe-then-POST contract as the Wiki
 * librarian strip. Live step events ride the per-user agent-runs
 * Broadcast channel; this module subscribes BEFORE the POST (the
 * pre-subscribe rule streaming chat established) and filters on the
 * runId it minted, so a stale or concurrent run's events can't cross
 * into this strip. Cross-run mutual exclusion is server-side - the
 * shared memory-librarian in-flight guard folds collisions into a
 * `busy` result - so the only local guard needed is against
 * double-submitting from this same module.
 *
 * The confirmation step deliberately stays panel-local: it's pre-run
 * UI with nothing in flight, so losing it on navigation (and
 * re-opening with one click) is fine.
 */
import type { AgentRunProgressEvent, SupabaseService } from '../supabase';
import { emitMemoryChange } from '../memory-events';
import {
  pushStep,
  deepSleepResultLine,
  remResultLine,
  type MemoryLibrarianPass,
  type MemoryLibrarianStep,
} from '../ui/memory-librarian';

interface LibrarianRunState {
  /** Which pass is active or was last shown. Null = strip is clear. */
  pass: MemoryLibrarianPass | null;
  steps: MemoryLibrarianStep[];
  resultLine: string | null;
  resultText: string | null;
  error: string | null;
  running: boolean;
}

const state = $state<LibrarianRunState>({
  pass: null,
  steps: [],
  resultLine: null,
  resultText: null,
  error: null,
  running: false,
});

interface StartDeps {
  supabase: SupabaseService;
}

/**
 * Map a wire progress event onto the step-list event union. The wire
 * `preparing` carries the agent-specific count field; the step-list
 * primitives want the pass-tagged variant so the label copy can name
 * the work unit.
 */
function stepEventFor(
  pass: MemoryLibrarianPass,
  event: AgentRunProgressEvent
): Parameters<typeof pushStep>[1] {
  if (event.kind === 'preparing') {
    return pass === 'deep-sleep'
      ? { kind: 'deep-sleep-preparing', batchSize: event.batchSize ?? 0 }
      : { kind: 'rem-preparing', conversationCount: event.conversationCount ?? 0 };
  }
  return event;
}

const BUSY_MESSAGE =
  'Another memory-librarian run is already in flight (scheduled, or the ' +
  'other pass). Try again in a moment.';

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
    return state.running;
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
   * Guards against double-submitting locally; everything else
   * (collisions with scheduled runs or the other pass) is the
   * server-side guard's job and comes back as a `busy` result.
   */
  async start(pass: MemoryLibrarianPass, deps: StartDeps): Promise<void> {
    if (state.running) return;
    state.running = true;
    state.pass = pass;
    state.steps = [];
    state.resultLine = null;
    state.resultText = null;
    state.error = null;

    const runId = crypto.randomUUID();
    let unsubscribe: (() => void) | null = null;
    try {
      const session = await deps.supabase.getSession();
      if (!session) {
        state.error = 'Not signed in.';
        return;
      }
      unsubscribe = deps.supabase.subscribeToAgentRunProgress(
        session.user.id,
        (event) => {
          if (event.runId === runId) pushStep(state.steps, stepEventFor(pass, event));
        }
      );

      if (pass === 'deep-sleep') {
        const result = await deps.supabase.runDeepSleep({ runId });
        if (result.kind === 'busy') {
          state.error = BUSY_MESSAGE;
          return;
        }
        state.resultLine = deepSleepResultLine({
          kind: result.kind,
          batchSize: result.kind === 'ok' || result.kind === 'too-small' ? result.batchSize : 0,
          toolCalls: result.kind === 'ok' ? result.toolCalls : 0,
        });
        if (result.kind === 'error') {
          state.error = result.error ?? 'Deep-sleep run failed.';
        } else if (result.kind === 'ok' && result.finalText.trim().length > 0) {
          state.resultText = result.finalText.trim();
        }
      } else {
        const result = await deps.supabase.runRem({ runId });
        if (result.kind === 'busy') {
          state.error = BUSY_MESSAGE;
          return;
        }
        state.resultLine = remResultLine({
          kind: result.kind,
          conversationsProcessed:
            result.kind === 'ok' ? result.conversationsProcessed : 0,
          toolCalls: result.kind === 'ok' ? result.toolCalls : 0,
        });
        if (result.kind === 'error') {
          state.error = result.error ?? 'Rem run failed.';
        } else if (result.kind === 'ok' && result.finalText.trim().length > 0) {
          state.resultText = result.finalText.trim();
        }
      }
      // Fire the local refresh immediately - the memories realtime
      // echo also arrives, but consumers refetch idempotently and the
      // local fire keeps the panel snappy.
      emitMemoryChange();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe?.();
      state.running = false;
    }
  },
};
