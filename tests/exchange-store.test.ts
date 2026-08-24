/**
 * Coverage for ExchangeStore and the mergeMessagesById helper.
 *
 * The store is essentially `Map<threadId, ExchangeSlot>` with three
 * things layered on: lazy slot creation, ordered iteration, and
 * abort-on-dispose. Each behaviour gets a focused test. The merge
 * helper pins the race-management contract from the Phase 2 plan:
 * rows the chat-loop persisted while the user was switching threads
 * fold back into the right place when listMessages settles.
 */
import { describe, it, expect } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import { ExchangeStore, mergeMessagesById } from '../src/lib/exchange/exchange-store.svelte';
import { ExchangeSlot } from '../src/lib/exchange/exchange-slot.svelte';
import type { Message } from '../src/lib/supabase';

function msg(id: string, position: number | null, overrides: Partial<Message> = {}): Message {
  return {
    id,
    thread_id: 't1',
    role: 'assistant',
    content: id,
    created_at: '2026-05-20T00:00:00Z',
    position,
    ...overrides,
  };
}

describe('ExchangeStore', () => {
  it('uses SvelteMap so $derived consumers re-evaluate when a slot is added', () => {
    // Regression: `$state(new Map())` does NOT make Map operations
    // reactive in Svelte 5 - only plain objects and arrays get the
    // deep proxy. A consumer that does `$derived(store.peek(id))`
    // would silently miss the slot allocated by `send()` if this
    // ever reverts to a plain Map. The user-visible symptom was the
    // streaming bubble never appearing and the "incomplete turn"
    // banner sitting under the user message while the assistant
    // response was in flight - both gated on `activeSlot?.sending`,
    // which read as undefined when the derived couldn't see the
    // slot.
    const store = new ExchangeStore();
    store.slotFor('t1');
    const internalMap = (store as unknown as { map: unknown }).map;
    expect(internalMap).toBeInstanceOf(SvelteMap);
  });

  it('returns the same slot instance across slotFor calls for one thread', () => {
    const store = new ExchangeStore();
    const a1 = store.slotFor('t1');
    const a2 = store.slotFor('t1');
    expect(a1).toBe(a2);
    expect(a1).toBeInstanceOf(ExchangeSlot);
  });

  it('allocates a distinct slot per thread', () => {
    const store = new ExchangeStore();
    const a = store.slotFor('t1');
    const b = store.slotFor('t2');
    expect(a).not.toBe(b);
    a.streamingText = 'a';
    b.streamingText = 'b';
    expect(a.streamingText).toBe('a');
    expect(b.streamingText).toBe('b');
  });

  it('peek does NOT allocate a slot', () => {
    const store = new ExchangeStore();
    expect(store.peek('t1')).toBeUndefined();
    expect(store.slots()).toEqual([]);
    const created = store.slotFor('t1');
    expect(store.peek('t1')).toBe(created);
  });

  it('slots() returns every allocated slot', () => {
    const store = new ExchangeStore();
    const a = store.slotFor('t1');
    const b = store.slotFor('t2');
    expect(store.slots()).toEqual([a, b]);
  });

  it('dispose aborts an in-flight controller and removes the slot', () => {
    const store = new ExchangeStore();
    const slot = store.slotFor('t1');
    slot.abortCtl = new AbortController();
    const signal = slot.abortCtl.signal;
    store.dispose('t1');
    expect(signal.aborted).toBe(true);
    expect(store.peek('t1')).toBeUndefined();
  });

  it('dispose is a no-op for an unknown thread', () => {
    const store = new ExchangeStore();
    expect(() => store.dispose('nope')).not.toThrow();
  });

  it('dispose does not throw when the slot has no abortCtl', () => {
    const store = new ExchangeStore();
    store.slotFor('t1');
    expect(() => store.dispose('t1')).not.toThrow();
    expect(store.peek('t1')).toBeUndefined();
  });

  it('disposeAll aborts every controller and clears the map', () => {
    const store = new ExchangeStore();
    const a = store.slotFor('t1');
    const b = store.slotFor('t2');
    a.abortCtl = new AbortController();
    b.abortCtl = new AbortController();
    const signalA = a.abortCtl.signal;
    const signalB = b.abortCtl.signal;
    store.disposeAll();
    expect(signalA.aborted).toBe(true);
    expect(signalB.aborted).toBe(true);
    expect(store.slots()).toEqual([]);
  });
});

describe('mergeMessagesById', () => {
  it('returns the fetched list unchanged when the buffer is empty', () => {
    const fetched = [msg('a', 1), msg('b', 2)];
    expect(mergeMessagesById(fetched, [], 't1')).toEqual(fetched);
  });

  it('folds a buffer-only row into the right timeline slot', () => {
    const fetched = [msg('a', 1), msg('c', 3)];
    const buffered = [msg('b', 2)];
    const merged = mergeMessagesById(fetched, buffered, 't1');
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders a fractional recovery-row position into its gap', () => {
    // Healed recovery rows carry fractional positions between their
    // integer neighbors - the merge must interleave them, not sort
    // them to either end.
    const fetched = [msg('a', 1), msg('c', 2)];
    const buffered = [msg('b', 1.5)];
    const merged = mergeMessagesById(fetched, buffered, 't1');
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('prefers the fetched row when the buffer has the same id', () => {
    const fetched = [msg('a', 1, { content: 'canonical' })];
    const buffered = [msg('a', 1, { content: 'stale' })];
    const merged = mergeMessagesById(fetched, buffered, 't1');
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe('canonical');
  });

  it('sorts a null position to the tail and ties break by id', () => {
    // A null position (a row inserted in a schema apply's
    // backfill-to-trigger window) sorts after every positioned row,
    // matching the tail slot the next backfill sweep assigns it.
    const fetched = [msg('z', null), msg('m', 5)];
    const buffered = [msg('a', null)];
    const merged = mergeMessagesById(fetched, buffered, 't1');
    expect(merged.map((m) => m.id)).toEqual(['m', 'a', 'z']);
  });

  it('handles a buffer that lands strictly after the snapshot', () => {
    const fetched = [msg('a', 1)];
    const buffered = [msg('b', 2), msg('c', 3)];
    const merged = mergeMessagesById(fetched, buffered, 't1');
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps inherited fork-prefix rows at the head instead of sorting by position', () => {
    // A fork-resolved snapshot opens with ancestor-owned rows whose
    // positions restart independently of the fork's own segment.
    // Sorting the whole list by bare position would interleave the
    // segments (parent 1,2 with own 1,2); the merge must leave the
    // inherited head in snapshot order and only position-sort the
    // thread's own rows plus the buffer.
    const fetched = [
      msg('p1', 1, { thread_id: 'parent' }),
      msg('p2', 2, { thread_id: 'parent' }),
      msg('own1', 1),
    ];
    const buffered = [msg('own2', 2)];
    const merged = mergeMessagesById(fetched, buffered, 't1');
    expect(merged.map((m) => m.id)).toEqual(['p1', 'p2', 'own1', 'own2']);
  });
});
