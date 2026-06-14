// In-flight lease watcher - the run-liveness signal every client reads.
//
// A manual or scheduled librarian run claims a TTL lease on the user's
// profiles row (<agent>_inflight_expires_at). This watcher tracks that
// lease via realtime + an initial read and exposes a single `running`
// boolean, so any surface can react: the top-bar button disables while a
// run is in flight, the panel shows a spinner, and - because scheduled
// background runs hold the SAME lease - the UI lights up for those too,
// not just user-triggered ones.
//
// It is a server fact with a TTL, not an ephemeral event, which is what
// makes it the robust backstop: even if the per-run progress broadcast
// is dropped, the lease clearing (or its TTL lapsing) still settles the
// UI. Generic across fleets via the column; the wiki singleton is
// exported here, the memory librarians get their own the same way.

import type { InflightLeaseColumn, SupabaseService } from '../supabase';

export interface InflightLeaseWatcher {
  /** True while a run (any client, manual or scheduled) holds the lease. */
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
  // to flip `running` off at the expiry instant: a lease that lapses by
  // TTL (a crashed run that never released) writes no row, so no realtime
  // UPDATE fires - the timer is what eventually clears a stale spinner.
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

// Shared singleton for the wiki librarian lease. Read by the top-bar
// sparkle button (disable while running) and the Wiki panel (spinner);
// started once when the wiki feature mounts (Chat.svelte) and stopped on
// sign-out / teardown.
export const wikiLibrarianLease = createInflightLeaseWatcher(
  'wiki_librarian_inflight_expires_at'
);
