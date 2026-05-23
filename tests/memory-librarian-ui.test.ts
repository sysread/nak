/**
 * Unit coverage for the memory librarian's step-list bookkeeping.
 * Translates the runner progress events into the rows Memories.svelte
 * renders in the strip.
 */
import { describe, it, expect } from 'vitest';
import {
  pushStep,
  settleTrailingPending,
  deepSleepResultLine,
  remResultLine,
  librarianPassInfo,
  type MemoryLibrarianStep,
} from '../src/lib/ui/memory-librarian';

describe('librarianPassInfo', () => {
  it('returns a deep-sleep title and description', () => {
    const info = librarianPassInfo('deep-sleep');
    expect(info.title).toMatch(/deep-sleep/i);
    expect(info.description.length).toBeGreaterThan(0);
    expect(info.description).toMatch(/consolidat/i);
  });

  it('returns a rem title and description', () => {
    const info = librarianPassInfo('rem');
    expect(info.title).toMatch(/rem/i);
    expect(info.description.length).toBeGreaterThan(0);
    expect(info.description).toMatch(/connection|link|graph/i);
  });

  it('distinguishes the two passes', () => {
    expect(librarianPassInfo('deep-sleep').title).not.toBe(
      librarianPassInfo('rem').title,
    );
  });
});

describe('pushStep', () => {
  it('opens a pending row on deep-sleep preparing', () => {
    const steps: MemoryLibrarianStep[] = [];
    pushStep(steps, { kind: 'deep-sleep-preparing', batchSize: 3 });
    expect(steps).toEqual([
      { label: 'Loading 3 memories', status: 'pending' },
    ]);
  });

  it('pluralises correctly for single-item batches', () => {
    const steps: MemoryLibrarianStep[] = [];
    pushStep(steps, { kind: 'deep-sleep-preparing', batchSize: 1 });
    expect(steps[0].label).toBe('Loading 1 memory');
  });

  it('opens a pending row on rem preparing with conversations', () => {
    const steps: MemoryLibrarianStep[] = [];
    pushStep(steps, { kind: 'rem-preparing', conversationCount: 2 });
    expect(steps).toEqual([
      { label: 'Loading 2 conversations', status: 'pending' },
    ]);
  });

  it('shows a settled empty-queue row when rem has no conversations', () => {
    const steps: MemoryLibrarianStep[] = [];
    pushStep(steps, { kind: 'rem-preparing', conversationCount: 0 });
    expect(steps).toEqual([
      { label: 'No conversations to process', status: 'ok' },
    ]);
  });

  it('settles the trailing pending row when thinking arrives', () => {
    const steps: MemoryLibrarianStep[] = [
      { label: 'Loading 3 memories', status: 'pending' },
    ];
    pushStep(steps, { kind: 'thinking', round: 1 });
    expect(steps).toEqual([
      { label: 'Loading 3 memories', status: 'ok' },
      { label: 'Thinking (round 1)', status: 'pending' },
    ]);
  });

  it('uses the tool activity label when present', () => {
    const steps: MemoryLibrarianStep[] = [];
    pushStep(steps, {
      kind: 'tool',
      name: 'memory_consolidate',
      activity: 'Merging the two prefers-tabs memories',
      ok: true,
      ms: 124,
    });
    expect(steps).toEqual([
      { label: 'Merging the two prefers-tabs memories', status: 'ok' },
    ]);
  });

  it('falls back to the tool name when activity is empty', () => {
    const steps: MemoryLibrarianStep[] = [];
    pushStep(steps, {
      kind: 'tool',
      name: 'memory_relate',
      activity: '   ',
      ok: true,
      ms: 80,
    });
    expect(steps[0].label).toBe('memory_relate');
  });

  it('marks tool rows as error when ok=false', () => {
    const steps: MemoryLibrarianStep[] = [];
    pushStep(steps, {
      kind: 'tool',
      name: 'memory_relate',
      activity: 'Linking A and B',
      ok: false,
      ms: 5,
    });
    expect(steps[0].status).toBe('error');
  });

  it('settles the trailing pending row on done(ok)', () => {
    const steps: MemoryLibrarianStep[] = [
      { label: 'Thinking (round 2)', status: 'pending' },
    ];
    pushStep(steps, { kind: 'done', ok: true });
    expect(steps[0].status).toBe('ok');
  });

  it('settles the trailing pending row to error on done(!ok)', () => {
    const steps: MemoryLibrarianStep[] = [
      { label: 'Thinking (round 2)', status: 'pending' },
    ];
    pushStep(steps, { kind: 'done', ok: false });
    expect(steps[0].status).toBe('error');
  });

  it('done with no trailing pending row is a no-op', () => {
    const steps: MemoryLibrarianStep[] = [
      { label: 'Done thing', status: 'ok' },
    ];
    pushStep(steps, { kind: 'done', ok: true });
    expect(steps).toEqual([{ label: 'Done thing', status: 'ok' }]);
  });
});

describe('settleTrailingPending', () => {
  it('flips the trailing pending row to ok', () => {
    const steps: MemoryLibrarianStep[] = [
      { label: 'a', status: 'ok' },
      { label: 'b', status: 'pending' },
    ];
    settleTrailingPending(steps);
    expect(steps[1].status).toBe('ok');
  });

  it('leaves a trailing settled row alone', () => {
    const steps: MemoryLibrarianStep[] = [{ label: 'a', status: 'ok' }];
    settleTrailingPending(steps);
    expect(steps[0].status).toBe('ok');
  });

  it('handles empty arrays', () => {
    const steps: MemoryLibrarianStep[] = [];
    expect(() => settleTrailingPending(steps)).not.toThrow();
  });
});

describe('deepSleepResultLine', () => {
  it('formats a happy-path summary', () => {
    expect(
      deepSleepResultLine({ kind: 'ok', batchSize: 5, toolCalls: 2 })
    ).toBe('Reviewed 5 memories with 2 tool calls.');
  });

  it('pluralises correctly for single-item batches', () => {
    expect(
      deepSleepResultLine({ kind: 'ok', batchSize: 1, toolCalls: 1 })
    ).toBe('Reviewed 1 memory with 1 tool call.');
  });

  it('describes the no-eligible case', () => {
    expect(
      deepSleepResultLine({ kind: 'no-eligible', batchSize: 0, toolCalls: 0 })
    ).toMatch(/No eligible memories/);
  });

  it('describes the lonely-seed case', () => {
    expect(
      deepSleepResultLine({ kind: 'too-small', batchSize: 1, toolCalls: 0 })
    ).toMatch(/no similarity neighbors/);
  });

  it('describes the error case', () => {
    expect(
      deepSleepResultLine({ kind: 'error', batchSize: 3, toolCalls: 1 })
    ).toMatch(/failed/);
  });
});

describe('remResultLine', () => {
  it('formats a happy-path summary', () => {
    expect(
      remResultLine({
        kind: 'ok',
        conversationsProcessed: 3,
        toolCalls: 5,
      })
    ).toBe('Processed 3 conversations with 5 tool calls.');
  });

  it('pluralises correctly', () => {
    expect(
      remResultLine({
        kind: 'ok',
        conversationsProcessed: 1,
        toolCalls: 1,
      })
    ).toBe('Processed 1 conversation with 1 tool call.');
  });

  it('describes the empty-queue case', () => {
    expect(
      remResultLine({
        kind: 'empty-queue',
        conversationsProcessed: 0,
        toolCalls: 0,
      })
    ).toMatch(/new recall activity/);
  });
});
