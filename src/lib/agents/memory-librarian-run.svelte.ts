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
import type {
  AgentRunProgressEvent,
  DeepSleepRunResult,
  ManualRunOutcome,
  RemRunResult,
  SupabaseService,
} from '../supabase';
import { emitMemoryChange } from '../memory-events';
import { awaitDetachedRun } from './detached-run';
import {
  pushStep,
  deepSleepResultLine,
  remResultLine,
  outcomeToMemoryDisplay,
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

// The runId whose outcome this store is currently displaying. Set when a
// live run starts (this tab owns that runId's display) and when a recovered
// outcome is applied. Guards applyOutcome from re-applying the same run's
// outcome over a live result, or re-applying it on every realtime tick.
let displayedRunId: string | null = null;

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
  // The terminal `result` event belongs to the detached run pattern
  // (detachedManualRunHandler); the memory librarians still use the
  // synchronous manualRunHandler, so they never receive it. Excluded here
  // so the non-result events map cleanly onto the step union; the caller
  // also skips it defensively.
  event: Exclude<AgentRunProgressEvent, { kind: 'result' }>
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
   * Render a persisted manual-run outcome recovered after a reload (read
   * on mount, or delivered by the profiles realtime UPDATE when a run
   * finishes while this tab watches). Bridged in from the
   * `memoryLibrarianOutcome` watcher. No-ops when:
   *  - a live run is in flight here (it owns the display);
   *  - we already show this runId (the live path set it, or a prior
   *    realtime tick applied it - the subscription fires on every profiles
   *    UPDATE, so the same outcome arrives repeatedly);
   *  - the outcome isn't a memory-librarian one (wrong source / busy).
   * The recovered strip carries no step rows - those are gone after a
   * reload - just the pass header and the result line/text.
   */
  applyOutcome(outcome: ManualRunOutcome): void {
    if (state.running) return;
    if (outcome.runId === displayedRunId) return;
    const display = outcomeToMemoryDisplay(outcome);
    if (!display) return;
    state.pass = display.pass;
    state.steps = [];
    state.resultLine = display.resultLine;
    state.resultText = display.resultText;
    state.error = display.error;
    displayedRunId = outcome.runId;
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
    // This tab owns this runId's display now - so the recovered-outcome
    // bridge (applyOutcome) won't later overwrite the live result when the
    // same run's outcome arrives over the profiles realtime UPDATE.
    displayedRunId = runId;
    try {
      const session = await deps.supabase.getSession();
      if (!session) {
        state.error = 'Not signed in.';
        return;
      }
      const supa = deps.supabase;
      const userId = session.user.id;
      // Detached run: the POST returns {accepted:true}; the run continues
      // server-side and the result arrives as the terminal event.
      // awaitDetachedRun subscribes-before-kick, streams progress into the
      // step list, and resolves with the result union.
      const onProgress = (event: AgentRunProgressEvent): void => {
        // awaitDetachedRun intercepts the terminal `result`; narrow it off
        // so the step-list mapper only sees progress phases.
        if (event.kind === 'result') return;
        pushStep(state.steps, stepEventFor(pass, event));
      };

      if (pass === 'deep-sleep') {
        const result = await awaitDetachedRun<DeepSleepRunResult>({
          supabase: supa,
          userId,
          runId,
          post: () => supa.runDeepSleep({ runId }),
          onProgress,
        });
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
        const result = await awaitDetachedRun<RemRunResult>({
          supabase: supa,
          userId,
          runId,
          post: () => supa.runRem({ runId }),
          onProgress,
        });
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
      // The kick failed (transport/auth) or awaitDetachedRun's inactivity
      // backstop fired. The detached run may have committed memory changes
      // before a dropped channel, so still refresh to surface them.
      state.error = err instanceof Error ? err.message : String(err);
      emitMemoryChange();
    } finally {
      state.running = false;
    }
  },
};
