/**
 * Lifecycle coverage for ExchangeSlot.
 *
 * The slot is a passive state container - it doesn't drive Venice or
 * Supabase itself; runExchange writes into it and the screen reads from
 * it. These tests pin the post-construction defaults, the reset() shape,
 * and the persistedRows / orphan-timing finalization helpers so the
 * surrounding plumbing can refactor without accidentally changing the
 * slot's observable behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExchangeSlot } from '../src/lib/exchange/exchange-slot.svelte';
import type { Message } from '../src/lib/supabase';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    thread_id: 't1',
    role: 'assistant',
    content: 'hi',
    created_at: '2026-05-20T00:00:00Z',
    position: 1,
    ...overrides,
  };
}

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
    expect(slot.persistedRows).toEqual([]);
    expect(slot.abortReason).toBeNull();
  });

  it('accepts writes to every field and reads them back', () => {
    const slot = new ExchangeSlot();
    const ctl = new AbortController();
    slot.sending = true;
    slot.streamingText = 'hello';
    slot.streamingReasoning = 'thinking';
    slot.streamingReasoningOpen = true;
    slot.streamingContentStarted = true;
    slot.streamingError = { kind: 'internal', detail: 'oops' };
    slot.rateLimitWaitUntil = 1234;
    slot.rateLimitAttempt = 2;
    slot.abortCtl = ctl;
    slot.toolTimings = { a: { startedAt: 1 } };

    expect(slot.sending).toBe(true);
    expect(slot.streamingText).toBe('hello');
    expect(slot.streamingReasoning).toBe('thinking');
    expect(slot.streamingReasoningOpen).toBe(true);
    expect(slot.streamingContentStarted).toBe(true);
    expect(slot.streamingError).toEqual({ kind: 'internal', detail: 'oops' });
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
    slot.streamingError = { kind: 'internal', detail: 'err', retry: () => {} };
    slot.rateLimitWaitUntil = 9999;
    slot.rateLimitAttempt = 3;
    slot.abortCtl = new AbortController();
    slot.toolTimings = { a: { startedAt: 1, endedAt: 2 } };
    slot.recordPersistedRow(makeMessage());
    slot.abortReason = 'claim';

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
    expect(slot.persistedRows).toEqual([]);
    expect(slot.abortReason).toBeNull();
  });

  it('reset() preserves queued messages - they belong to the next turn', () => {
    // reset() runs at the head of EVERY exchange, including the
    // rate-limit retry closure's re-entry into runExchange. Clearing
    // `queued` there would silently eat messages the user banked while
    // watching a 429 back-off; the drain is the only thing that empties
    // the array.
    const slot = new ExchangeSlot();
    slot.queued = [{ id: 'q1', text: 'and another thing', attachments: [] }];
    slot.sending = true;

    slot.reset();

    expect(slot.sending).toBe(false);
    expect(slot.queued).toEqual([{ id: 'q1', text: 'and another thing', attachments: [] }]);
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

  describe('recordPersistedRow', () => {
    it('appends rows in call order', () => {
      const slot = new ExchangeSlot();
      const a = makeMessage({ id: 'a', created_at: '2026-05-20T00:00:00Z' });
      const b = makeMessage({ id: 'b', created_at: '2026-05-20T00:00:01Z' });
      slot.recordPersistedRow(a);
      slot.recordPersistedRow(b);
      expect(slot.persistedRows.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('skips duplicates by id', () => {
      const slot = new ExchangeSlot();
      const a = makeMessage({ id: 'a' });
      slot.recordPersistedRow(a);
      slot.recordPersistedRow({ ...a, content: 'edited' });
      expect(slot.persistedRows).toHaveLength(1);
      expect(slot.persistedRows[0].content).toBe('hi');
    });
  });

  describe('finalizePendingToolTimings', () => {
    beforeEach(() => {
      vi.spyOn(performance, 'now').mockReturnValue(500);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('marks any timing without endedAt as errored with the current clock', () => {
      const slot = new ExchangeSlot();
      slot.toolTimings = {
        running: { startedAt: 100 },
        done: { startedAt: 100, endedAt: 200 },
        errored: { startedAt: 100, endedAt: 150, error: true },
      };
      slot.finalizePendingToolTimings();
      expect(slot.toolTimings).toEqual({
        running: { startedAt: 100, endedAt: 500, error: true },
        done: { startedAt: 100, endedAt: 200 },
        errored: { startedAt: 100, endedAt: 150, error: true },
      });
    });

    it('is a no-op when nothing is pending', () => {
      const slot = new ExchangeSlot();
      slot.toolTimings = { a: { startedAt: 100, endedAt: 200 } };
      slot.finalizePendingToolTimings();
      expect(slot.toolTimings).toEqual({ a: { startedAt: 100, endedAt: 200 } });
    });
  });
});
