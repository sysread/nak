// awaitDetachedRun - the client half of the detached manual-run pattern
// (server half: detachedManualRunHandler in the venice function).
//
// A detached run's POST returns {accepted:true} immediately and the run
// continues server-side past the gateway window; its progress and final
// outcome arrive over the agent-runs Broadcast channel instead of the
// HTTP body. This helper hides that split: subscribe BEFORE the kick
// (the pre-subscribe rule streaming chat established), route progress
// events to a callback, and resolve with the run's result when the
// terminal `result` event arrives - so callers keep their familiar
// `const result = await run(); map(result)` shape.
//
// Reusable across fleets: the wiki librarian uses it now; the memory
// librarians flip to it by swapping their await call. The fleet-specific
// result-union narrowing stays at the call site (generic T).

import type { AgentRunProgressEvent, SupabaseService } from '../supabase';

export interface AwaitDetachedRunDeps {
  supabase: SupabaseService;
  /** The signed-in user id - the agent-runs channel is per-user. */
  userId: string;
  /** Client-minted demux key; only events carrying it are this run's. */
  runId: string;
  /** Kick the detached run (the POST). Resolves on accept, throws on transport/auth failure. */
  post: () => Promise<void>;
  /** Called for each non-terminal progress event (preparing/thinking/tool/done). */
  onProgress?: (event: AgentRunProgressEvent) => void;
  /**
   * Inactivity backstop in ms (default 180s): reject if no event arrives
   * for this long. The detached run holds a server-side lease with its
   * own TTL, so this is only a client-side safety net against a fully
   * dropped channel - it resets on EVERY event, so a long-but-progressing
   * run is never cut off mid-flight.
   */
  inactivityMs?: number;
}

/**
 * Resolve with the detached run's result (the `result` event payload,
 * narrowed to T by the caller). Rejects if the kick fails or no event
 * arrives within the inactivity window. Always tears down the
 * subscription and timer before settling.
 */
export function awaitDetachedRun<T = unknown>(deps: AwaitDetachedRunDeps): Promise<T> {
  const { supabase, userId, runId, post, onProgress, inactivityMs = 180_000 } = deps;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finish = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      apply();
    };

    const armTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        finish(() => reject(new Error('detached run timed out (no progress events)')));
      }, inactivityMs);
    };

    // Subscribe first so the earliest events can't race the kick.
    unsubscribe = supabase.subscribeToAgentRunProgress(userId, (event) => {
      if (event.runId !== runId) return;
      armTimer();
      if (event.kind === 'result') {
        finish(() => resolve(event.result as T));
        return;
      }
      onProgress?.(event);
    });

    armTimer();
    post().catch((err) => {
      // The kick itself failed - the run never started, so nothing will
      // arrive on the channel. Settle now rather than wait out the timer.
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
  });
}
