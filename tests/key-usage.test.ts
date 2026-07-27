/**
 * Unit coverage for the browser half of the Usage pane's per-key headline:
 * the boundary check over the `key-usage` route's response
 * (`coerceKeyUsage`), the store that caches it, and the two display
 * primitives that shape it.
 *
 * The selection logic - which /api_keys row is ours - runs server-side and is
 * covered by supabase/functions/tests/key-usage.test.ts. What matters here is
 * that a null result stays a first-class answer all the way to the pane rather
 * than being mistaken for "not loaded yet" or for an error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VeniceError } from '../src/lib/venice';
import { coerceKeyUsage, type KeyUsage } from '../src/lib/usage';
import { keyUsageSpendParts, keyUsageTitle } from '../src/lib/ui/usage';
import {
  keyUsage,
  refreshKeyUsage,
  shouldAutoRefreshKeyUsage,
  resetUsage,
  USAGE_STALE_MS,
} from '../src/lib/usage-store.svelte';

function sample(overrides: Partial<KeyUsage> = {}): KeyUsage {
  return { description: 'nak-personal', usd: 12.43, diem: 0, ...overrides };
}

describe('coerceKeyUsage', () => {
  it('accepts a well-formed row', () => {
    expect(coerceKeyUsage({ description: 'nak-personal', usd: 12.43, diem: 0 })).toEqual(
      sample()
    );
  });

  it('treats null as the "could not identify the key" answer, not a failure', () => {
    expect(coerceKeyUsage(null)).toBeNull();
  });

  it('rejects a row missing or mistyping any field', () => {
    expect(coerceKeyUsage({ usd: 1, diem: 0 })).toBeNull();
    expect(coerceKeyUsage({ description: 'k', diem: 0 })).toBeNull();
    expect(coerceKeyUsage({ description: 'k', usd: 1 })).toBeNull();
    // Venice sends strings on the wire; the edge function parses them, so a
    // string arriving here means the shape drifted and should not be trusted.
    expect(coerceKeyUsage({ description: 'k', usd: '1', diem: '0' })).toBeNull();
  });
});

describe('keyUsageSpendParts', () => {
  it('shows only the denominations actually spent', () => {
    expect(keyUsageSpendParts({ usd: 12.43, diem: 0 })).toEqual([
      { currency: 'USD', amount: 12.43 },
    ]);
    expect(keyUsageSpendParts({ usd: 0, diem: 4.25 })).toEqual([
      { currency: 'DIEM', amount: 4.25 },
    ]);
  });

  it('puts USD first when both are present', () => {
    expect(keyUsageSpendParts({ usd: 1, diem: 2 }).map((p) => p.currency)).toEqual([
      'USD',
      'DIEM',
    ]);
  });

  it('falls back to a zero USD figure so a quiet key renders as $0 not blank', () => {
    expect(keyUsageSpendParts({ usd: 0, diem: 0 })).toEqual([
      { currency: 'USD', amount: 0 },
    ]);
  });
});

describe('keyUsageTitle', () => {
  it('names the key and warns that the window ignores the date pickers', () => {
    const title = keyUsageTitle('nak-personal');
    expect(title).toContain('nak-personal');
    expect(title).toContain('7 days');
    expect(title).toContain('does not follow');
  });
});

describe('the keyUsage store', () => {
  beforeEach(() => {
    resetUsage();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetUsage();
  });

  it('populates on a successful fetch', async () => {
    await refreshKeyUsage({ fetchKeyUsage: async () => sample() });
    expect(keyUsage.data).toEqual(sample());
    expect(keyUsage.error).toBeNull();
    expect(keyUsage.loading).toBe(false);
  });

  // The distinction the pane's markup depends on: a stamped lastFetchedAt with
  // null data means "asked Venice, could not identify the key", which is a
  // different message from "not loaded yet".
  it('stamps lastFetchedAt even when the key could not be identified', async () => {
    await refreshKeyUsage({ fetchKeyUsage: async () => null });
    expect(keyUsage.data).toBeNull();
    expect(keyUsage.lastFetchedAt).not.toBeNull();
    expect(keyUsage.error).toBeNull();
  });

  it('captures a fetch failure without stamping lastFetchedAt', async () => {
    await refreshKeyUsage({
      fetchKeyUsage: async () => {
        throw new VeniceError('Venice api_keys 401: unauthorized', 'http', 401);
      },
    });
    expect(keyUsage.error).toContain('401');
    expect(keyUsage.lastFetchedAt).toBeNull();
    expect(keyUsage.loading).toBe(false);
  });

  it('auto-refreshes when empty and again once the cache goes stale', async () => {
    expect(shouldAutoRefreshKeyUsage()).toBe(true);
    await refreshKeyUsage({ fetchKeyUsage: async () => sample() });
    expect(shouldAutoRefreshKeyUsage()).toBe(false);
    vi.advanceTimersByTime(USAGE_STALE_MS + 1);
    expect(shouldAutoRefreshKeyUsage()).toBe(true);
  });

  // Without this guard the on-open effect re-fires the instant `loading`
  // clears, hammering /api_keys. Manual Refresh is the retry path.
  it('does not auto-refresh after a failure', async () => {
    await refreshKeyUsage({
      fetchKeyUsage: async () => {
        throw new Error('down');
      },
    });
    expect(shouldAutoRefreshKeyUsage()).toBe(false);
  });

  it('is wiped by resetUsage so a different project key starts clean', async () => {
    await refreshKeyUsage({ fetchKeyUsage: async () => sample() });
    resetUsage();
    expect(keyUsage.data).toBeNull();
    expect(keyUsage.lastFetchedAt).toBeNull();
  });
});
