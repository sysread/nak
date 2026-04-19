/**
 * Unit coverage for LeaseCoordinator.
 *
 * The coordinator wraps four moving parts — three RPCs and a
 * setInterval — and the interesting behaviour shows up at their
 * boundaries: did a thrown error trip the onLost callback? did a
 * successful RPC return of `false` trip it? does release() stop the
 * interval even if we never acquired? We inject mock timers and a mock
 * SupabaseService so each test drives one behaviour deterministically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseCoordinator, type LeaseTimers } from '../src/lib/embeddings/lease';
import type { SupabaseService } from '../src/lib/supabase';

/** Test double for SupabaseService — just the three lease methods. */
function mockSupabase(): {
  svc: SupabaseService;
  spies: {
    acquireEmbeddingLease: ReturnType<typeof vi.fn>;
    heartbeatEmbeddingLease: ReturnType<typeof vi.fn>;
    releaseEmbeddingLease: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    acquireEmbeddingLease: vi.fn(async () => true),
    heartbeatEmbeddingLease: vi.fn(async () => true),
    releaseEmbeddingLease: vi.fn(async () => undefined),
  };
  return { svc: spies as unknown as SupabaseService, spies };
}

/**
 * Manual timers: the interval callback is captured so tests can fire
 * it themselves with `fireInterval()`. Keeps timing exact without
 * Vitest's fake-timers changing global semantics.
 */
function makeManualTimers(): LeaseTimers & { fireInterval: () => Promise<void> } {
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
      // immediately and resolves on a microtask. Drain one tick so
      // tests see the post-beat state.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('LeaseCoordinator', () => {
  let svc: SupabaseService;
  let spies: ReturnType<typeof mockSupabase>['spies'];
  let timers: ReturnType<typeof makeManualTimers>;

  beforeEach(() => {
    ({ svc, spies } = mockSupabase());
    timers = makeManualTimers();
  });

  describe('config validation', () => {
    it('rejects heartbeat >= TTL (would let lease expire between beats)', () => {
      expect(
        () =>
          new LeaseCoordinator(svc, 'h', { ttlSeconds: 10, heartbeatMs: 10_000 }, timers)
      ).toThrow(/must be less than/);
    });

    it('accepts heartbeat comfortably below TTL', () => {
      expect(
        () =>
          new LeaseCoordinator(svc, 'h', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers)
      ).not.toThrow();
    });
  });

  describe('acquire', () => {
    it('returns true and flips isHolding when the RPC grants the lease', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      const ok = await co.acquire();
      expect(ok).toBe(true);
      expect(co.isHolding).toBe(true);
      expect(spies.acquireEmbeddingLease).toHaveBeenCalledWith('h1', 45);
    });

    it('returns false and leaves isHolding false on contention', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(false);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      expect(await co.acquire()).toBe(false);
      expect(co.isHolding).toBe(false);
    });

    it('propagates RPC errors — callers decide how to back off', async () => {
      spies.acquireEmbeddingLease.mockRejectedValueOnce(new Error('network'));
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await expect(co.acquire()).rejects.toThrow(/network/);
      expect(co.isHolding).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('no-ops when we do not hold the lease', async () => {
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      const onLost = vi.fn();
      co.startHeartbeat(onLost);
      // No interval was armed — firing would throw in our mock.
      await expect(() => timers.fireInterval()).rejects.toThrow(/no active/);
    });

    it('refreshes the lease while the RPC keeps returning true', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);

      spies.heartbeatEmbeddingLease.mockResolvedValue(true);
      await timers.fireInterval();
      await timers.fireInterval();
      await timers.fireInterval();

      expect(spies.heartbeatEmbeddingLease).toHaveBeenCalledTimes(3);
      expect(onLost).not.toHaveBeenCalled();
      expect(co.isHolding).toBe(true);
    });

    it('fires onLost and flips isHolding when heartbeat returns false', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);

      spies.heartbeatEmbeddingLease.mockResolvedValueOnce(false);
      await timers.fireInterval();

      expect(onLost).toHaveBeenCalledOnce();
      expect(co.isHolding).toBe(false);
    });

    it('swallows thrown errors — one failed beat is not decisive', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);

      spies.heartbeatEmbeddingLease.mockRejectedValueOnce(new Error('boom'));
      // Should not reject, should not fire onLost.
      await timers.fireInterval();
      expect(onLost).not.toHaveBeenCalled();
      expect(co.isHolding).toBe(true);

      // A subsequent successful beat continues normally.
      spies.heartbeatEmbeddingLease.mockResolvedValueOnce(true);
      await timers.fireInterval();
      expect(co.isHolding).toBe(true);
    });

    it('stops the interval after a decisive loss so old timers do not fire onLost twice', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);

      spies.heartbeatEmbeddingLease.mockResolvedValueOnce(false);
      await timers.fireInterval();
      expect(onLost).toHaveBeenCalledOnce();

      // After loss, the interval is cleared — firing again would be a
      // test bug because our mock tracks a single current callback and
      // clearInterval sets it to null.
      await expect(timers.fireInterval()).rejects.toThrow(/no active/);
    });

    it('startHeartbeat is idempotent — duplicate calls do not stack intervals', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.acquire();
      const onLost = vi.fn();
      co.startHeartbeat(onLost);
      co.startHeartbeat(onLost); // second call should replace, not duplicate

      spies.heartbeatEmbeddingLease.mockResolvedValueOnce(true);
      await timers.fireInterval();
      // One beat per fire — not two.
      expect(spies.heartbeatEmbeddingLease).toHaveBeenCalledTimes(1);
    });
  });

  describe('release', () => {
    it('calls the release RPC and flips isHolding when we held the lease', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.acquire();
      await co.release();
      expect(spies.releaseEmbeddingLease).toHaveBeenCalledWith('h1');
      expect(co.isHolding).toBe(false);
    });

    it('is a no-op when we never held the lease', async () => {
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.release();
      expect(spies.releaseEmbeddingLease).not.toHaveBeenCalled();
    });

    it('swallows release RPC errors — the TTL will sweep anyway', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      spies.releaseEmbeddingLease.mockRejectedValueOnce(new Error('offline'));
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.acquire();
      await expect(co.release()).resolves.toBeUndefined();
      expect(co.isHolding).toBe(false);
    });

    it('stops the heartbeat interval even if the release RPC errors', async () => {
      spies.acquireEmbeddingLease.mockResolvedValueOnce(true);
      const co = new LeaseCoordinator(svc, 'h1', { ttlSeconds: 45, heartbeatMs: 20_000 }, timers);
      await co.acquire();
      co.startHeartbeat(() => {});
      spies.releaseEmbeddingLease.mockRejectedValueOnce(new Error('offline'));
      await co.release();
      await expect(timers.fireInterval()).rejects.toThrow(/no active/);
    });
  });
});
