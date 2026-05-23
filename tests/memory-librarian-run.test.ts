/**
 * Unit coverage for the navigation-stable librarian run store. The
 * point of this module is that the run's UI state lives on a
 * singleton (so it survives the Memories panel being unmounted
 * mid-run), and that `start()` streams progress into that singleton.
 * We mock the two runner modules so the store's orchestration is
 * exercised without touching Venice / Supabase or the real agents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeepSleepProgress } from '../src/lib/agents/deep-sleep/runner.svelte';
import type { RemProgress } from '../src/lib/agents/rem/runner.svelte';

// Mutable busy flags the mocked runner singletons expose; tests flip
// these to simulate an in-flight run.
const deepSleepState = { manualBusy: false, workerBusy: false };
const remState = { manualBusy: false, workerBusy: false };

const runDeepSleepManually = vi.fn();
const runRemManually = vi.fn();

vi.mock('../src/lib/agents/deep-sleep/runner.svelte', () => ({
  deepSleepRunner: {
    get manualBusy() {
      return deepSleepState.manualBusy;
    },
    get workerBusy() {
      return deepSleepState.workerBusy;
    },
    get busy() {
      return deepSleepState.manualBusy || deepSleepState.workerBusy;
    },
  },
  runManually: (opts: unknown) => runDeepSleepManually(opts),
}));

vi.mock('../src/lib/agents/rem/runner.svelte', () => ({
  remRunner: {
    get manualBusy() {
      return remState.manualBusy;
    },
    get workerBusy() {
      return remState.workerBusy;
    },
    get busy() {
      return remState.manualBusy || remState.workerBusy;
    },
  },
  runManually: (opts: unknown) => runRemManually(opts),
}));

import { librarianRun } from '../src/lib/agents/memory-librarian-run.svelte';

function fakeDeps(session: { user: { id: string } } | null = { user: { id: 'u1' } }) {
  return {
    supabase: { getSession: vi.fn(async () => session) },
    venice: {},
  } as unknown as Parameters<typeof librarianRun.start>[1];
}

beforeEach(() => {
  deepSleepState.manualBusy = false;
  deepSleepState.workerBusy = false;
  remState.manualBusy = false;
  remState.workerBusy = false;
  runDeepSleepManually.mockReset();
  runRemManually.mockReset();
  librarianRun.clear();
});

describe('librarianRun store', () => {
  it('starts clear and inactive', () => {
    expect(librarianRun.pass).toBeNull();
    expect(librarianRun.active).toBe(false);
    expect(librarianRun.steps).toEqual([]);
  });

  it('streams deep-sleep progress into the singleton and lands a result', async () => {
    runDeepSleepManually.mockImplementation(
      async (opts: { onProgress: (e: DeepSleepProgress) => void }) => {
        opts.onProgress({ kind: 'preparing', batchSize: 3 });
        opts.onProgress({ kind: 'thinking', round: 1 });
        opts.onProgress({
          kind: 'tool',
          name: 'memory_consolidate',
          activity: 'Merging duplicates',
          ok: true,
          ms: 50,
        });
        opts.onProgress({ kind: 'done', ok: true });
        return {
          kind: 'ok',
          finalText: 'Merged two memories.',
          toolCalls: 1,
          batchSize: 3,
        };
      },
    );

    await librarianRun.start('deep-sleep', fakeDeps());

    expect(librarianRun.pass).toBe('deep-sleep');
    expect(librarianRun.active).toBe(true);
    // preparing + thinking + tool rows landed (done settles, no new row).
    expect(librarianRun.steps.length).toBeGreaterThanOrEqual(3);
    expect(librarianRun.resultLine).toMatch(/Reviewed 3 memories/);
    expect(librarianRun.resultText).toBe('Merged two memories.');
    expect(librarianRun.error).toBeNull();
  });

  it('streams rem progress and lands a result', async () => {
    runRemManually.mockImplementation(
      async (opts: { onProgress: (e: RemProgress) => void }) => {
        opts.onProgress({ kind: 'preparing', conversationCount: 2 });
        opts.onProgress({ kind: 'done', ok: true });
        return {
          kind: 'ok',
          finalText: '',
          toolCalls: 0,
          conversationsProcessed: 2,
        };
      },
    );

    await librarianRun.start('rem', fakeDeps());

    expect(librarianRun.pass).toBe('rem');
    expect(librarianRun.resultLine).toMatch(/Processed 2 conversations/);
    // Empty finalText leaves resultText null.
    expect(librarianRun.resultText).toBeNull();
  });

  it('records an error and does not call the runner when not signed in', async () => {
    await librarianRun.start('deep-sleep', fakeDeps(null));
    expect(librarianRun.error).toBe('Not signed in.');
    expect(runDeepSleepManually).not.toHaveBeenCalled();
  });

  it('refuses to start while a run is already in flight', async () => {
    deepSleepState.manualBusy = true;
    await librarianRun.start('rem', fakeDeps());
    expect(runRemManually).not.toHaveBeenCalled();
  });

  it('surfaces a runner error result as the strip error', async () => {
    runDeepSleepManually.mockResolvedValue({
      kind: 'error',
      finalText: '',
      toolCalls: 0,
      batchSize: 0,
      error: 'boom',
    });
    await librarianRun.start('deep-sleep', fakeDeps());
    expect(librarianRun.error).toBe('boom');
  });

  it('clear() resets the strip when no run is in flight', async () => {
    runDeepSleepManually.mockResolvedValue({
      kind: 'ok',
      finalText: 'done',
      toolCalls: 0,
      batchSize: 1,
    });
    await librarianRun.start('deep-sleep', fakeDeps());
    expect(librarianRun.active).toBe(true);
    librarianRun.clear();
    expect(librarianRun.active).toBe(false);
    expect(librarianRun.pass).toBeNull();
  });

  it('clear() is a no-op while a run is in flight', async () => {
    runDeepSleepManually.mockImplementation(async () => {
      // Simulate the run still being in flight when clear() is called.
      deepSleepState.manualBusy = true;
      return { kind: 'ok', finalText: 'x', toolCalls: 0, batchSize: 1 };
    });
    await librarianRun.start('deep-sleep', fakeDeps());
    // manualBusy left true by the mock - clear() should bail.
    librarianRun.clear();
    expect(librarianRun.pass).toBe('deep-sleep');
  });
});
