/**
 * Unit coverage for resolveHolderId.
 *
 * Asserts the behaviours the chat-loop's stale-claim recovery relies on:
 *   - A second call returns the same id (the refresh-during-completion
 *     regression that motivated a stable holderId).
 *   - The id survives a sessionStorage wipe - the mobile-reload case
 *     that broke the earlier sessionStorage-backed tabSeq scheme.
 *   - A cleared localStorage (new browser profile / cache clear) mints a
 *     fresh id, so a genuinely different browser is a distinct holder.
 *   - A storage-throws environment falls back to a random id instead of
 *     crashing.
 *
 * jsdom provides real localStorage / sessionStorage so we test against
 * the actual platform surface rather than a hand-rolled mock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveHolderId } from '../src/lib/exchange/holder-id';

const HOLDER_KEY = 'nak:holder:id';

describe('resolveHolderId', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('returns a non-empty id', () => {
    expect(resolveHolderId()).toBeTruthy();
  });

  it('a second call returns the same id (refresh survival)', () => {
    const first = resolveHolderId();
    const second = resolveHolderId();
    expect(second).toBe(first);
  });

  it('survives a sessionStorage wipe (the PWA-reload case)', () => {
    const first = resolveHolderId();
    // Installed PWAs (reproduced on Android Chrome) have been observed
    // to drop sessionStorage across a reload; localStorage is what must
    // carry the identity across the refresh.
    window.sessionStorage.clear();
    const second = resolveHolderId();
    expect(second).toBe(first);
  });

  it('a cleared localStorage (new browser profile) mints a fresh id', () => {
    const first = resolveHolderId();
    window.localStorage.clear();
    const second = resolveHolderId();
    expect(second).not.toBe(first);
  });

  it('persists the id under nak:holder:id', () => {
    const id = resolveHolderId();
    expect(window.localStorage.getItem(HOLDER_KEY)).toBe(id);
  });

  it('reuses an id already present in localStorage rather than minting a new one', () => {
    window.localStorage.setItem(HOLDER_KEY, 'preexisting-id');
    expect(resolveHolderId()).toBe('preexisting-id');
  });

  it('falls back to a random id when storage access throws', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage unavailable');
      },
    });
    try {
      const id = resolveHolderId();
      expect(id).toBeTruthy();
      expect(id.length).toBeGreaterThan(0);
    } finally {
      if (original) {
        Object.defineProperty(window, 'localStorage', original);
      }
      vi.restoreAllMocks();
    }
  });
});
