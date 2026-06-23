// In-flight run watcher - the run-liveness signal every client reads.
//
// A manual or scheduled librarian run stamps a TTL-backed
// <agent>_inflight_expires_at column on the user's profiles row. This
// watcher tracks that server-side expiry via realtime + an initial read
// and exposes a single `running` boolean, so any surface can react: the
// top-bar button disables while a run is in flight, the panel shows a
// spinner, and - because scheduled background runs stamp the SAME expiry
// - the UI lights up for those too, not just user-triggered ones.
//
// It is a server fact with a TTL, not an ephemeral event, which is what
// makes it the robust backstop: even if the per-run progress broadcast
// is dropped, clearing the expiry (or letting it lapse) still settles
// the UI. This is unrelated to the deleted browser-worker
// `worker_leases` apparatus; the only thing shared is the informal word
// "lease". Generic across fleets via the column; the wiki singleton is
// exported here, the memory librarians get their own the same way.

import type {
  InflightLeaseColumn,
  LastRunOutcomeColumn,
  ManualRunOutcome,
  SupabaseService,
} from '../supabase';

export interface InflightLeaseWatcher {
  /** True while a run (any client, manual or scheduled) still holds the TTL-backed inflight expiry. */
  readonly running: boolean;
  /** Begin watching. Idempotent - a second call while active is a no-op. */
  start(deps: { supabase: SupabaseService; userId: string }): void;
  /** Stop watching and clear state (sign-out / teardown). */
  stop(): void;
}

export function createInflightLeaseWatcher(
  column: InflightLeaseColumn
): InflightLeaseWatcher {
  const state = $state<{ expiry: string | null }>({ expiry: null });
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  // Apply a fresh expiry from realtime or the initial read. Arms a timer
  // to flip `running` off at the expiry instant: a crashed run that
  // never clears its expiry writes no row, so no realtime UPDATE fires -
  // the timer is what eventually clears a stale spinner.
  const apply = (expiry: string | null): void => {
    if (!active) return;
    clearTimer();
    if (!expiry) {
      state.expiry = null;
      return;
    }
    const ms = new Date(expiry).getTime() - Date.now();
    if (ms <= 0) {
      state.expiry = null;
      return;
    }
    state.expiry = expiry;
    timer = setTimeout(() => {
      state.expiry = null;
      timer = null;
    }, ms);
  };

  return {
    get running(): boolean {
      return state.expiry !== null;
    },
    start(deps): void {
      if (active) return;
      active = true;
      unsubscribe = deps.supabase.subscribeToInflightLease(deps.userId, column, apply);
      // Initial read so an already-running run (a refresh mid-run, or a
      // scheduled run already in flight) shows immediately, ahead of the
      // next realtime transition.
      void deps.supabase
        .getInflightLeaseExpiry(deps.userId, column)
        .then((expiry) => {
          // Don't clobber a realtime update that may have already landed:
          // only seed from the initial read while still unset.
          if (active && state.expiry === null) apply(expiry);
        })
        .catch(() => {
          // Best-effort; the next realtime transition corrects it.
        });
    },
    stop(): void {
      active = false;
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;
      state.expiry = null;
    },
  };
}

// Shared singleton for the wiki librarian run watcher. Read by the
// top-bar sparkle button (disable while running) and the Wiki panel
// (spinner); started once when the wiki feature mounts (Chat.svelte)
// and stopped on sign-out / teardown.
export const wikiLibrarianLease = createInflightLeaseWatcher(
  'wiki_librarian_inflight_expires_at'
);

// Shared singleton for the memory librarian run watcher (rem + deep-sleep
// share one in-flight guard, so one watcher covers both passes). Read by
// the Memories top-bar buttons (disable while running) and the panel;
// started in Chat.svelte alongside the wiki one.
export const memoryLibrarianLease = createInflightLeaseWatcher(
  'memory_librarian_inflight_expires_at'
);

// Outcome-recovery watcher - the run-liveness lease's twin. The lease
// answers "is a run happening"; this answers "what did the last run do",
// so a tab that reloaded can re-render the result card the live Broadcast
// already delivered and lost. It reads the `*_last_run_outcome` profiles
// column on start (recovering a run that finished while away) and watches
// the same profiles realtime UPDATE the lease rides (recovering one that
// finishes while the tab is open - the venice function's outcome write is
// itself a profiles UPDATE, so the new tuple carries the fresh envelope).
//
// No expiry timer: an outcome is a sticky last-value, not a TTL fact. The
// consuming panel guards against re-showing an outcome over a fresher live
// run (by runId), so this watcher just surfaces the latest stored value.
export interface LastRunOutcomeWatcher {
  /** The most-recent stored manual-run outcome, or null if none/unreadable. */
  readonly outcome: ManualRunOutcome | null;
  /** Begin watching. Idempotent - a second call while active is a no-op. */
  start(deps: { supabase: SupabaseService; userId: string }): void;
  /** Stop watching and clear state (sign-out / teardown). */
  stop(): void;
}

export function createLastRunOutcomeWatcher(
  column: LastRunOutcomeColumn
): LastRunOutcomeWatcher {
  const state = $state<{ outcome: ManualRunOutcome | null }>({ outcome: null });
  let unsubscribe: (() => void) | null = null;
  let active = false;

  return {
    get outcome(): ManualRunOutcome | null {
      return state.outcome;
    },
    start(deps): void {
      if (active) return;
      active = true;
      unsubscribe = deps.supabase.subscribeToLastRunOutcome(deps.userId, column, (o) => {
        if (active) state.outcome = o;
      });
      // Initial read so an outcome that landed while the tab was away (the
      // reload-after-finish case) shows immediately. Don't clobber a
      // realtime value that may have already arrived - seed only while unset.
      void deps.supabase
        .getLastRunOutcome(deps.userId, column)
        .then((o) => {
          if (active && state.outcome === null) state.outcome = o;
        })
        .catch(() => {
          // Best-effort; the next realtime UPDATE corrects it.
        });
    },
    stop(): void {
      active = false;
      unsubscribe?.();
      unsubscribe = null;
      state.outcome = null;
    },
  };
}

// Outcome-recovery singletons, twins of the two lease singletons above.
// Started/stopped in Chat.svelte with the session; read by the Wiki panel
// (librarian result card) and bridged into the memory librarianRun store.
export const wikiLibrarianOutcome = createLastRunOutcomeWatcher(
  'wiki_librarian_last_run_outcome'
);
export const memoryLibrarianOutcome = createLastRunOutcomeWatcher(
  'memory_librarian_last_run_outcome'
);
