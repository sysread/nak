/**
 * Unit tests for the messages-channel subscribe-status decision module
 * (src/lib/chat/realtime-recovery.ts). The module encodes the state
 * and transition matrix in
 * docs/dev/plans/realtime-delivery-fixes-plan.md:
 *
 *   - SUBSCRIBED resets the failure streak and triggers the ONE
 *     catch-up reconcile (a re-join after a dark period is a genuine
 *     re-subscribe and gets its own catch-up).
 *   - The first failure of a streak resubscribes (postgres_changes
 *     channels get a fresh topic per subscription, so the re-run is
 *     safe); a second CONSECUTIVE failure only warns - the transcript
 *     correctness rests on the reconciles, and a channel that never
 *     reaches SUBSCRIBED must not churn forever.
 *   - CLOSED is debug-only: realtime-js status semantics for CLOSED
 *     vary by version, and our own teardown echoes through it - never
 *     a resubscribe trigger.
 */
import { describe, expect, it } from 'vitest';
import { messagesSubscribeDecision } from '../src/lib/chat/realtime-recovery';

describe('messagesSubscribeDecision', () => {
  it('SUBSCRIBED resets the streak and fires the catch-up', () => {
    expect(messagesSubscribeDecision('SUBSCRIBED', 0)).toEqual({
      action: 'catch-up',
      nextAttempts: 0,
    });
    // A re-subscribe after failures gets its own catch-up and resets.
    expect(messagesSubscribeDecision('SUBSCRIBED', 1)).toEqual({
      action: 'catch-up',
      nextAttempts: 0,
    });
  });

  it('the first failure of a streak resubscribes', () => {
    expect(messagesSubscribeDecision('CHANNEL_ERROR', 0)).toEqual({
      action: 'resubscribe',
      nextAttempts: 1,
    });
    expect(messagesSubscribeDecision('TIMED_OUT', 0)).toEqual({
      action: 'resubscribe',
      nextAttempts: 1,
    });
  });

  it('a second consecutive failure warns without resubscribing', () => {
    expect(messagesSubscribeDecision('CHANNEL_ERROR', 1)).toEqual({
      action: 'log-warn',
      nextAttempts: 2,
    });
    expect(messagesSubscribeDecision('TIMED_OUT', 5)).toEqual({
      action: 'log-warn',
      nextAttempts: 6,
    });
  });

  it('CLOSED is debug-only and leaves the streak untouched', () => {
    expect(messagesSubscribeDecision('CLOSED', 0)).toEqual({
      action: 'log-debug',
      nextAttempts: 0,
    });
    expect(messagesSubscribeDecision('CLOSED', 3)).toEqual({
      action: 'log-debug',
      nextAttempts: 3,
    });
  });
});
