/**
 * Unit coverage for resolveHolderId.
 *
 * Asserts the behaviours the chat-loop's stale-claim recovery relies
 * on:
 *   - Refresh in the same tab returns the same holderId (the
 *     refresh-during-completion regression that motivated the
 *     localStorage + sessionStorage split).
 *   - A new tab (fresh sessionStorage, shared localStorage) gets a
 *     different tabSeq, so two tabs of the same browser are visible
 *     to each other as separate holders.
 *   - A new browser (cleared localStorage) mints a fresh browserId.
 *   - A storage-throws environment falls back to a random id instead
 *     of crashing.
 *
 * jsdom provides real localStorage / sessionStorage so we test against
 * the actual platform surface rather than a hand-rolled mock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveHolderId } from '../src/lib/exchange/holder-id';

const BROWSER_KEY = 'nak:holder:browser';
const TAB_KEY = 'nak:holder:tab';
const COUNTER_KEY = 'nak:holder:counter';

describe('resolveHolderId', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('returns a `${browserId}:${tabSeq}` shape', () => {
    const id = resolveHolderId();
    expect(id).toMatch(/^[^:]+:\d+$/);
  });

  it('a second call in the same tab returns the same id (refresh survival)', () => {
    // First mount: stamps both storage slots.
    const first = resolveHolderId();
    // Simulated refresh: storage persists, but we call resolve again.
    // The second call must see the existing entries and return them.
    const second = resolveHolderId();
    expect(second).toBe(first);
  });

  it('a "new tab" (sessionStorage cleared, localStorage retained) keeps browserId but bumps tabSeq', () => {
    const first = resolveHolderId();
    const [firstBrowser, firstSeq] = first.split(':');
    // Simulate opening a fresh tab: sessionStorage is per-tab so it
    // starts empty; localStorage is per-origin so it carries over.
    window.sessionStorage.clear();
    const second = resolveHolderId();
    const [secondBrowser, secondSeq] = second.split(':');
    expect(secondBrowser).toBe(firstBrowser);
    expect(secondSeq).not.toBe(firstSeq);
    expect(Number.parseInt(secondSeq, 10)).toBe(
      Number.parseInt(firstSeq, 10) + 1
    );
  });

  it('a "new browser" (both stores cleared) mints a fresh browserId and resets the tab counter', () => {
    const first = resolveHolderId();
    // Simulate a brand-new browser profile or a cache clear.
    window.localStorage.clear();
    window.sessionStorage.clear();
    const second = resolveHolderId();
    const [firstBrowser] = first.split(':');
    const [secondBrowser, secondSeq] = second.split(':');
    expect(secondBrowser).not.toBe(firstBrowser);
    // Counter restarts from 1, not from wherever the previous browser
    // left off.
    expect(secondSeq).toBe('1');
  });

  it('the counter monotonically increases across successive new-tab opens', () => {
    const seqs: number[] = [];
    for (let i = 0; i < 4; i++) {
      window.sessionStorage.clear();
      const id = resolveHolderId();
      seqs.push(Number.parseInt(id.split(':')[1], 10));
    }
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('persists browserId under nak:holder:browser', () => {
    const id = resolveHolderId();
    const [browserId] = id.split(':');
    expect(window.localStorage.getItem(BROWSER_KEY)).toBe(browserId);
  });

  it('persists tabSeq under nak:holder:tab and the counter under nak:holder:counter', () => {
    const id = resolveHolderId();
    const [, tabSeq] = id.split(':');
    expect(window.sessionStorage.getItem(TAB_KEY)).toBe(tabSeq);
    expect(window.localStorage.getItem(COUNTER_KEY)).toBe(tabSeq);
  });

  it('a corrupt counter value (NaN or negative) restarts from 1', () => {
    window.localStorage.setItem(COUNTER_KEY, 'not-a-number');
    const id = resolveHolderId();
    expect(id.split(':')[1]).toBe('1');
  });

  it('falls back to a random id when storage access throws', () => {
    const originalLocal = Object.getOwnPropertyDescriptor(
      window,
      'localStorage'
    );
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage unavailable');
      },
    });
    try {
      const id = resolveHolderId();
      // Random fallback returns a non-empty string with no colon-split
      // shape, just a uuid or a uuid-like substitute. We assert "not
      // empty" rather than a specific shape so a future tweak to the
      // fallback format doesn't break this test.
      expect(id).toBeTruthy();
      expect(id.length).toBeGreaterThan(0);
    } finally {
      if (originalLocal) {
        Object.defineProperty(window, 'localStorage', originalLocal);
      }
      vi.restoreAllMocks();
    }
  });
});
