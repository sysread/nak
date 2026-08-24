/**
 * Per-thread map of ExchangeSlot. The Chat screen owns one instance;
 * the slot for a given thread is created on first send and persists
 * for the lifetime of the screen so a thread-switch + return doesn't
 * lose the in-flight state.
 *
 * The store is intentionally minimal:
 *
 *   - slotFor(threadId): get-or-create. Allocation is cheap (one
 *     `ExchangeSlot()` plus a Map.set), so the lazy path keeps the
 *     map shape obvious: a slot exists iff someone has asked for it.
 *
 *   - peek(threadId): get-without-create. Used by the screen-wide
 *     "is anything streaming?" check (drives the wake lock) so we
 *     don't materialize slots for threads we've only listed in the
 *     drawer.
 *
 *   - slots(): the active set. Iterated by the wake-lock effect and
 *     by the screen-level cleanup on sign-out.
 *
 *   - dispose(threadId): drop the slot. Called when a thread is
 *     deleted (or the realtime feed says so). Aborts any in-flight
 *     exchange via the slot's abortCtl on the way out so a slot
 *     dropped mid-stream doesn't keep its chat-loop callbacks
 *     writing into a buffer no one will ever read.
 *
 *   - disposeAll(): teardown for screen unmount / lock. Same abort
 *     posture as dispose() applied to every slot.
 *
 * No reactivity on the map itself. The slot fields are $state-backed,
 * so consumers that hold a slot reference see field-level reactivity.
 * Consumers that iterate the map (the wake-lock effect, for example)
 * read the slots' reactive fields inside the iteration, which is
 * enough for the surrounding $effect to re-run when any slot's
 * `sending` flips.
 */

import { SvelteMap } from 'svelte/reactivity';
import { ExchangeSlot } from './exchange-slot.svelte';
import type { Message } from '../supabase';

export class ExchangeStore {
  /**
   * SvelteMap (not `$state(new Map())`): Svelte 5's `$state` only
   * deep-proxies plain objects and arrays. Built-in collections -
   * Map, Set, Date, URL - keep the operations they expose opaque
   * unless you reach for the explicit reactive wrapper from
   * `svelte/reactivity`. Without SvelteMap, `peek` and `slotFor`'s
   * `map.get(threadId)` does not subscribe the caller's $derived,
   * so a slot allocated by `send()` is invisible to the screen
   * until something else triggers a re-render. The user-visible
   * symptom: the streaming bubble never shows up and the
   * "incomplete turn" banner appears under the user message while
   * the assistant response is in flight, because the bubble is
   * gated on `activeSlot?.sending` and the banner is suppressed
   * by the same condition - both false-out when the map read
   * silently misses the new slot.
   */
  private readonly map = new SvelteMap<string, ExchangeSlot>();

  /**
   * Return the slot for `threadId`, creating it on first call.
   * Subsequent calls for the same thread return the same instance,
   * so a reference held across a thread switch keeps observing the
   * slot's reactive fields.
   */
  slotFor(threadId: string): ExchangeSlot {
    let slot = this.map.get(threadId);
    if (!slot) {
      slot = new ExchangeSlot();
      this.map.set(threadId, slot);
    }
    return slot;
  }

  /**
   * Return the slot for `threadId` if it already exists, without
   * creating one. For consumers that want to ask "is anything
   * happening on this thread yet?" without forcing allocation.
   */
  peek(threadId: string): ExchangeSlot | undefined {
    return this.map.get(threadId);
  }

  /** All allocated slots. Order is insertion order. */
  slots(): ExchangeSlot[] {
    return Array.from(this.map.values());
  }

  /**
   * Drop the slot for `threadId`. Aborts any in-flight exchange
   * first so the chat-loop's stream consumer settles and stops
   * writing into a buffer no one will read. Safe to call when no
   * slot exists; no-op in that case.
   */
  dispose(threadId: string): void {
    const slot = this.map.get(threadId);
    if (!slot) return;
    slot.abortCtl?.abort();
    this.map.delete(threadId);
  }

  /**
   * Drop every slot. Called on screen unmount / app lock / sign-out
   * so the cross-thread state doesn't leak across re-mounts. Same
   * abort posture as dispose().
   */
  disposeAll(): void {
    for (const slot of this.map.values()) {
      slot.abortCtl?.abort();
    }
    this.map.clear();
  }
}

/**
 * Merge `fetched` (the canonical snapshot from listMessages) with
 * `buffered` (rows the slot's chat-loop handlers persisted but may
 * not be in the snapshot), for the thread the screen is showing.
 * De-dupes by id, fetched rows winning.
 *
 * Use case: selecting a thread whose slot is mid-exchange. Between
 * `messages = []` (clear) and `messages = fetched` (snapshot resolve),
 * the chat-loop may have fired onAssistantPersisted / onToolResultPersisted
 * with new rows. The buffer captures them; the merge folds them back
 * in regardless of where they landed in the timeline.
 *
 * Ordering: `position` is per-SEGMENT transcript order, not global -
 * a forked thread's snapshot opens with rows inherited from ancestor
 * threads whose positions restart independently, so sorting the whole
 * list by position would interleave the segments. Inherited rows
 * (thread_id !== threadId) keep their snapshot order at the head;
 * only the thread's own rows - the segment every buffered row belongs
 * to - are sorted by position (fractional on healed recovery rows;
 * see the Message type doc). A null position sorts to the tail,
 * matching where the backfill sweep will place the row, and ties
 * break by id so the order is deterministic. On a thread with no fork
 * ancestry every row is "own" and this is the old whole-list sort.
 * Both inputs are read-only; the result is a fresh array.
 */
export function mergeMessagesById(
  fetched: Message[],
  buffered: Message[],
  threadId: string
): Message[] {
  if (buffered.length === 0) return fetched;
  const byId = new Map<string, Message>();
  for (const m of fetched) byId.set(m.id, m);
  for (const m of buffered) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  const inherited: Message[] = [];
  const own: Message[] = [];
  for (const m of byId.values()) {
    (m.thread_id === threadId ? own : inherited).push(m);
  }
  own.sort((a, b) => {
    const pa = a.position ?? Number.POSITIVE_INFINITY;
    const pb = b.position ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return inherited.concat(own);
}
