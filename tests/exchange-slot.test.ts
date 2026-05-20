/**
 * Lifecycle coverage for ExchangeSlot.
 *
 * The slot is a passive state container - it doesn't drive Venice or
 * Supabase itself; runExchange writes into it and the screen reads from
 * it. These tests pin the post-construction defaults and the reset()
 * shape so the Phase 2 work (per-thread slot map) can refactor the
 * surrounding plumbing without accidentally changing the slot's
 * observable behaviour.
 */
import { describe, it, expect } from 'vitest';
import { ExchangeSlot } from '../src/lib/exchange/exchange-slot.svelte';

describe('ExchangeSlot', () => {
  it('starts in the idle steady state', () => {
    const slot = new ExchangeSlot();
    expect(slot.sending).toBe(false);
    expect(slot.streamingText).toBe('');
    expect(slot.streamingReasoning).toBe('');
    expect(slot.streamingReasoningOpen).toBe(false);
    expect(slot.streamingContentStarted).toBe(false);
    expect(slot.streamingError).toBeNull();
    expect(slot.rateLimitWaitUntil).toBeNull();
    expect(slot.rateLimitAttempt).toBe(0);
    expect(slot.abortCtl).toBeNull();
    expect(slot.toolTimings).toEqual({});
  });

  it('accepts writes to every field and reads them back', () => {
    const slot = new ExchangeSlot();
    const ctl = new AbortController();
    slot.sending = true;
    slot.streamingText = 'hello';
    slot.streamingReasoning = 'thinking';
    slot.streamingReasoningOpen = true;
    slot.streamingContentStarted = true;
    slot.streamingError = { text: 'oops' };
    slot.rateLimitWaitUntil = 1234;
    slot.rateLimitAttempt = 2;
    slot.abortCtl = ctl;
    slot.toolTimings = { a: { startedAt: 1 } };

    expect(slot.sending).toBe(true);
    expect(slot.streamingText).toBe('hello');
    expect(slot.streamingReasoning).toBe('thinking');
    expect(slot.streamingReasoningOpen).toBe(true);
    expect(slot.streamingContentStarted).toBe(true);
    expect(slot.streamingError).toEqual({ text: 'oops' });
    expect(slot.rateLimitWaitUntil).toBe(1234);
    expect(slot.rateLimitAttempt).toBe(2);
    expect(slot.abortCtl).toBe(ctl);
    expect(slot.toolTimings).toEqual({ a: { startedAt: 1 } });
  });

  it('supports deep mutation of toolTimings', () => {
    const slot = new ExchangeSlot();
    slot.toolTimings['call-1'] = { startedAt: 100 };
    slot.toolTimings['call-1'] = {
      ...slot.toolTimings['call-1'],
      endedAt: 200,
    };
    expect(slot.toolTimings['call-1']).toEqual({ startedAt: 100, endedAt: 200 });
  });

  it('reset() returns every field to its idle value', () => {
    const slot = new ExchangeSlot();
    slot.sending = true;
    slot.streamingText = 'partial';
    slot.streamingReasoning = 'mid-thought';
    slot.streamingReasoningOpen = true;
    slot.streamingContentStarted = true;
    slot.streamingError = { text: 'err', retry: () => {} };
    slot.rateLimitWaitUntil = 9999;
    slot.rateLimitAttempt = 3;
    slot.abortCtl = new AbortController();
    slot.toolTimings = { a: { startedAt: 1, endedAt: 2 } };

    slot.reset();

    expect(slot.sending).toBe(false);
    expect(slot.streamingText).toBe('');
    expect(slot.streamingReasoning).toBe('');
    expect(slot.streamingReasoningOpen).toBe(false);
    expect(slot.streamingContentStarted).toBe(false);
    expect(slot.streamingError).toBeNull();
    expect(slot.rateLimitWaitUntil).toBeNull();
    expect(slot.rateLimitAttempt).toBe(0);
    expect(slot.abortCtl).toBeNull();
    expect(slot.toolTimings).toEqual({});
  });

  it('produces independent state between instances', () => {
    const a = new ExchangeSlot();
    const b = new ExchangeSlot();
    a.streamingText = 'one';
    b.streamingText = 'two';
    expect(a.streamingText).toBe('one');
    expect(b.streamingText).toBe('two');
    a.toolTimings['x'] = { startedAt: 1 };
    expect(b.toolTimings['x']).toBeUndefined();
  });
});
