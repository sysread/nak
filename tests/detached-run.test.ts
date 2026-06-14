/**
 * Unit coverage for awaitDetachedRun - the client half of the detached
 * manual-run pattern. Pure async orchestration over a fake SupabaseService
 * (subscribe + post), no network. Verifies it subscribes, routes progress,
 * resolves on the terminal `result` event, rejects on a kick failure, and
 * rejects on the inactivity backstop (reset by each event).
 */
import { describe, it, expect, vi } from 'vitest';
import { awaitDetachedRun } from '../src/lib/agents/detached-run';
import type { AgentRunProgressEvent, SupabaseService } from '../src/lib/supabase';

function makeHarness() {
  let cb: ((e: AgentRunProgressEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const supabase = {
    subscribeToAgentRunProgress(
      _userId: string,
      onEvent: (e: AgentRunProgressEvent) => void
    ) {
      cb = onEvent;
      return unsubscribe;
    },
  } as unknown as SupabaseService;
  return {
    supabase,
    unsubscribe,
    emit: (e: AgentRunProgressEvent) => cb?.(e),
  };
}

describe('awaitDetachedRun', () => {
  it('resolves with the result payload, routes progress, ignores other runIds', async () => {
    const h = makeHarness();
    const progress: AgentRunProgressEvent[] = [];
    const p = awaitDetachedRun<{ kind: string }>({
      supabase: h.supabase,
      userId: 'u',
      runId: 'r',
      post: () => Promise.resolve(),
      onProgress: (e) => progress.push(e),
    });

    h.emit({ runId: 'other', kind: 'thinking', round: 9 }); // not ours - ignored
    h.emit({ runId: 'r', kind: 'thinking', round: 1 });
    h.emit({ runId: 'r', kind: 'result', result: { kind: 'ok' } });

    await expect(p).resolves.toEqual({ kind: 'ok' });
    expect(progress).toEqual([{ runId: 'r', kind: 'thinking', round: 1 }]);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects when the kick (POST) fails, and tears down', async () => {
    const h = makeHarness();
    const p = awaitDetachedRun({
      supabase: h.supabase,
      userId: 'u',
      runId: 'r',
      post: () => Promise.reject(new Error('transport boom')),
    });
    await expect(p).rejects.toThrow('transport boom');
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects after the inactivity window when the channel goes silent', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const p = awaitDetachedRun({
        supabase: h.supabase,
        userId: 'u',
        runId: 'r',
        post: () => Promise.resolve(),
        inactivityMs: 1000,
      });
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the inactivity timer on each event so a long-but-live run survives', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const p = awaitDetachedRun<{ ok: boolean }>({
        supabase: h.supabase,
        userId: 'u',
        runId: 'r',
        post: () => Promise.resolve(),
        inactivityMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(800); // 800 < 1000, still alive
      h.emit({ runId: 'r', kind: 'thinking', round: 1 }); // resets the window
      await vi.advanceTimersByTimeAsync(800); // 1600 total, only 800 since last event
      h.emit({ runId: 'r', kind: 'result', result: { ok: true } });
      await expect(p).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
