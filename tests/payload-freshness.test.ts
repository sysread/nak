/**
 * Coverage for the priming-payload freshness display helpers. The
 * staleness verdict must track the injection threshold (STALE_FUSE_MS)
 * exactly, since the modal badge is meant to mean "the chat-loop would
 * suppress this."
 */
import { describe, it, expect } from 'vitest';
import {
  formatRelativeAge,
  isStaleForDisplay,
} from '../src/lib/ui/payload-freshness';
import { STALE_FUSE_MS } from '../src/lib/intuition';

const NOW = 1_700_000_000_000;

describe('formatRelativeAge', () => {
  it('reads sub-minute and future (skew) deltas as "just now"', () => {
    expect(formatRelativeAge(NOW, NOW)).toBe('just now');
    expect(formatRelativeAge(NOW - 30 * 1000, NOW)).toBe('just now');
    expect(formatRelativeAge(NOW + 5000, NOW)).toBe('just now'); // clock skew
  });

  it('renders minutes, hours, and days', () => {
    expect(formatRelativeAge(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatRelativeAge(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago');
    expect(formatRelativeAge(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d ago');
  });
});

describe('isStaleForDisplay', () => {
  it('is fresh under the injection threshold and stale at/over it', () => {
    expect(isStaleForDisplay(NOW, NOW)).toBe(false);
    expect(isStaleForDisplay(NOW, NOW + STALE_FUSE_MS - 1)).toBe(false);
    expect(isStaleForDisplay(NOW, NOW + STALE_FUSE_MS)).toBe(true);
    expect(isStaleForDisplay(NOW, NOW + STALE_FUSE_MS * 5)).toBe(true);
  });
});
