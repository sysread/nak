/**
 * Unit coverage for ThreadClaimCoordinator.
 *
 * Same general shape as embeddings-lease.test.ts because the
 * coordinator is structurally parallel to LeaseCoordinator. The
 * substantive difference is partition key: this one keys on threadId
 * (per-row claim) where LeaseCoordinator keys on workerKind (singleton
 * lease per kind). Same heartbeat / acquire / release semantics; same
 * RPC-false vs. RPC-throw distinction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ThreadClaimCoordinator,
  DEFAULT_THREAD_CLAIM_CONFIG,
  type ThreadClaimTimers,
} from '../src/lib/exchange/thread-claim-coordinator';
import type { SupabaseService } from '../src/lib/supabase';

/** Test double for SupabaseService — just the three claim methods. */
function mockSupabase(): {
  svc: SupabaseService;
  spies: {
    acquireThreadResponseClaim: ReturnType<typeof vi.fn>;
    heartbeatThreadResponseClaim: ReturnType<typeof vi.fn>;
    releaseThreadResponseClaim: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    acquireThreadResponseClaim: vi.fn(async () => true),
    heartbeatThreadResponseClaim: vi.fn(async () => true),
    releaseThreadResponseClaim: vi.fn(async () => undefined),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

/**
 * Manual timers: the interval callback is captured so tests can fire
 * it themselves with `fireInterval()`. Mirrors the shape used in
 * embeddings-lease.test.ts so the two tests stay legible side-by-side.
 */
function makeManualTimers(): ThreadClaimTimers & { fireInterval: () => Promise<void> } {
  let currentFn: (() => void) | null = null;
  const handle = Symbol('interval-handle') as unknown as ReturnType<typeof setInterval>;
  return {
    setInterval: (fn: () => void) => {
      currentFn = fn;
      return handle;
    },
    clearInterval: () => {
      currentFn = null;
    },
    async fireInterval() {
      if (!currentFn) throw new Error('fireInterval with no active interval');
      currentFn();
      // The interval callback does `void beatOnce(...)`, which returns
      // immediately and resolves on a microtask. Drain a couple of
      // ticks so tests see the post-beat state.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('ThreadClaimCoordinator', () => {
  let svc: SupabaseService;
  let spies: ReturnType<typeof mockSupabase>['spies'];
  let timers: ReturnType<typeof makeManualTimers>;

  const config = { ttlSeconds: 60, heartbeatMs: 20_000 };

  beforeEach(() => {
    ({ svc, spies } = mockSupabase());
    timers = makeManualTimers();
  });

  describe('config validation', () => {
    it('rejects heartbeat >= TTL (would let the claim expire between beats)', () => {
      expect(
        () => new ThreadClaimCoordinator(svc, 't1', 'h', { ttlSeconds: 10, heartbeatMs: 10_000 }, timers)
      ).toThrow(/must be less than/);
    });

    it('accepts heartbeat comfortably below TTL', () => {
      expect(
        () => new ThreadClaimCoordinator(svc, 't1', 'h', config, timers)
      ).not.toThrow();
    });

    it('exposes a default config aligned with the chat-turn TTL budget', () => {
      expect(DEFAULT_THREAD_CLAIM_CONFIG.ttlSeconds).toBe(60);
      expect(DEFAULT_THREAD_CLAIM_CONFIG.heartbeatMs).toBe(20_000);
    });
  });

  describe('acquire', () => {
    it('returns true and flips isHolding when the RPC grants the claim', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(true);
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      const ok = await co.acquire();
      expect(ok).toBe(true);
      expect(co.isHolding).toBe(true);
      expect(spies.acquireThreadResponseClaim).toHaveBeenCalledWith('t1', 'h1', 60);
    });

    it('returns false and leaves isHolding false on contention', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(false);
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      expect(await co.acquire()).toBe(false);
      expect(co.isHolding).toBe(false);
    });

    it('propagates RPC errors so callers can surface them on the inline banner', async () => {
      spies.acquireThreadResponseClaim.mockRejectedValueOnce(new Error('network'));
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await expect(co.acquire()).rejects.toThrow(/network/);
      expect(co.isHolding).toBe(false);
    });

    it('partitions by threadId so concurrent exchanges on different threads can coexist', async () => {
      // Two coordinators, two threads, both succeed - the RPC sees
      // distinct thread ids so the second acquire doesn't contend
      // with the first. Catches any regression that hard-coded a
      // single thread.
      spies.acquireThreadResponseClaim.mockResolvedValue(true);
      const a = new ThreadClaimCoordinator(svc, 't-a', 'h-a', config, timers);
      const b = new ThreadClaimCoordinator(svc, 't-b', 'h-b', config, timers);
      expect(await a.acquire()).toBe(true);
      expect(await b.acquire()).toBe(true);
      expect(spies.acquireThreadResponseClaim).toHaveBeenNthCalledWith(1, 't-a', 'h-a', 60);
      expect(spies.acquireThreadResponseClaim).toHaveBeenNthCalledWith(2, 't-b', 'h-b', 60);
    });
  });

  describe('heartbeat', () => {
    it('no-ops when we do not hold the claim', async () => {
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      const onLost = vi.fn();
      co.startHeartbeat(onLost);
      // No interval was armed - firing would throw in our mock.
      await expect(timers.fireInterval()).rejects.toThrow(/no active/);
    });

    it('refreshes the claim while the RPC keeps returning true', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(true);
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);

      spies.heartbeatThreadResponseClaim.mockResolvedValue(true);
      await timers.fireInterval();
      await timers.fireInterval();
      await timers.fireInterval();

      expect(spies.heartbeatThreadResponseClaim).toHaveBeenCalledTimes(3);
      expect(spies.heartbeatThreadResponseClaim).toHaveBeenLastCalledWith('t1', 'h1', 60);
      expect(onLost).not.toHaveBeenCalled();
      expect(co.isHolding).toBe(true);
    });

    it('fires onLost and flips isHolding when heartbeat returns false', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(true);
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);

      spies.heartbeatThreadResponseClaim.mockResolvedValueOnce(false);
      await timers.fireInterval();

      expect(onLost).toHaveBeenCalledOnce();
      expect(co.isHolding).toBe(false);
    });

    it('swallows thrown errors - one failed beat is not decisive', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(true);
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);

      spies.heartbeatThreadResponseClaim.mockRejectedValueOnce(new Error('boom'));
      // Should not reject, should not fire onLost.
      await timers.fireInterval();
      expect(onLost).not.toHaveBeenCalled();
      expect(co.isHolding).toBe(true);

      // A subsequent successful beat continues normally.
      spies.heartbeatThreadResponseClaim.mockResolvedValueOnce(true);
      await timers.fireInterval();
      expect(co.isHolding).toBe(true);
    });

    it('stops the interval after a decisive loss so old timers do not double-fire', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(true);
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);

      spies.heartbeatThreadResponseClaim.mockResolvedValueOnce(false);
      await timers.fireInterval();
      expect(onLost).toHaveBeenCalledOnce();

      await expect(timers.fireInterval()).rejects.toThrow(/no active/);
    });

    it('startHeartbeat is idempotent - duplicate calls do not stack intervals', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(true);
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);
      co.startHeartbeat(onLost); // second call should replace, not duplicate

      spies.heartbeatThreadResponseClaim.mockResolvedValueOnce(true);
      await timers.fireInterval();
      // One beat per fire - not two.
      expect(spies.heartbeatThreadResponseClaim).toHaveBeenCalledTimes(1);
    });
  });

  describe('release', () => {
    it('calls the release RPC and flips isHolding when we held the claim', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(true);
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await co.acquire();
      await co.release();
      expect(spies.releaseThreadResponseClaim).toHaveBeenCalledWith('t1', 'h1');
      expect(co.isHolding).toBe(false);
    });

    it('is a no-op when we never held the claim', async () => {
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await co.release();
      expect(spies.releaseThreadResponseClaim).not.toHaveBeenCalled();
    });

    it('swallows release RPC errors - the TTL will sweep on the server side', async () => {
      spies.acquireThreadResponseClaim.mockResolvedValueOnce(true);
      spies.releaseThreadResponseClaim.mockRejectedValueOnce(new Error('offline'));
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      await co.acquire();
      await expect(co.release()).resolves.toBeUndefined();
      expect(co.isHolding).toBe(false);
    });

    it('stops the heartbeat even when called without an acquire', async () => {
      const co = new ThreadClaimCoordinator(svc, 't1', 'h1', config, timers);
      co.startHeartbeat(() => {});
      // We never acquired - startHeartbeat should have been a no-op.
      await co.release();
      // No RPC, no interval, no throw.
      expect(spies.releaseThreadResponseClaim).not.toHaveBeenCalled();
    });
  });
});
