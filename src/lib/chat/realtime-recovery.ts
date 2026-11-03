/**
 * The messages realtime channel's subscribe-status decision, as a pure
 * function. Companion to subscribeToMessages
 * (src/lib/supabase/realtime.ts), which gained an optional status
 * callback; the Chat.svelte effect wires this decision to its
 * catch-up reconcile and resubscribe tick.
 *
 * Why a decision module: the caller's reaction to a status event is
 * policy (one catch-up per SUBSCRIBED, one resubscribe per
 * consecutive-failure streak, CLOSED never resubscribes) and the
 * policy lives in a state-and-transition matrix that is unit-tested
 * here - Chat.svelte itself is not mountable in tests (too coupled to
 * the live app state), so every decision that matters is extracted.
 *
 * The full matrix lives in
 * docs/dev/plans/realtime-delivery-fixes-plan.md ("STATE AND
 * TRANSITION MATRIX").
 */

export type MessageChannelStatus =
  | 'SUBSCRIBED'
  | 'CHANNEL_ERROR'
  | 'TIMED_OUT'
  | 'CLOSED';

/**
 * What the caller should do about a status event:
 *
 *   - 'catch-up'    - the channel joined: run the ONE catch-up
 *                     reconcile (also the signal to reset the streak
 *                     counter - the caller reads nextAttempts).
 *   - 'resubscribe' - first failure of a streak: bump the resubscribe
 *                     tick so the subscribing effect re-runs on a
 *                     fresh channel (postgres_changes channels take a
 *                     unique topic per subscription).
 *   - 'log-warn'    - second consecutive failure: log and stop; the
 *                     transcript reconciles carry correctness.
 *   - 'log-debug'   - informational only (CLOSED).
 */
export type SubscribeAction = 'catch-up' | 'resubscribe' | 'log-warn' | 'log-debug';

export interface SubscribeDecision {
  action: SubscribeAction;
  /**
   * The caller's new streak counter. 0 means "the channel is healthy"
   * (reset on SUBSCRIBED); a positive value counts consecutive
   * failures since the last successful subscribe.
   */
  nextAttempts: number;
}

/**
 * Decide the reaction to a messages-channel subscribe status.
 *
 * `attempts` is the caller's CURRENT consecutive-failure count for
 * this channel (0 on a fresh subscription). The resubscribe fires
 * only on the FIRST failure of a streak (attempts === 0): a channel
 * that repeatedly fails to join must not churn teardown/recreate
 * cycles forever - after one retry the transcript reconciles (the
 * SUBSCRIBED catch-up, the threads-echo backstop, the END-time
 * reconcile) own transcript correctness, and the warn log keeps the
 * failure visible.
 *
 * CLOSED is deliberately inert: realtime-js emits it on our own
 * teardown too, and its semantics vary across client versions - the
 * stream-transport precedent suppresses self-initiated CLOSED the
 * same way (setupStreamSubscription's closed-flag pattern).
 */
export function messagesSubscribeDecision(
  status: MessageChannelStatus,
  attempts: number
): SubscribeDecision {
  if (status === 'SUBSCRIBED') return { action: 'catch-up', nextAttempts: 0 };
  if (status === 'CLOSED') return { action: 'log-debug', nextAttempts: attempts };
  const nextAttempts = attempts + 1;
  return {
    action: nextAttempts === 1 ? 'resubscribe' : 'log-warn',
    nextAttempts,
  };
}
