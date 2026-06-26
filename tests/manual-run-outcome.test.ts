/**
 * Unit coverage for the browser side of manual-run outcome recovery: the
 * defensive coercion of the persisted jsonb envelope, and the two per-fleet
 * "outcome -> displayed result" transforms. These are the pure functions the
 * reload-recovery path leans on; the runes wiring (the watcher, the bridge
 * effects) composes them in Chat/Memories/Wiki.
 */
import { describe, it, expect } from 'vitest';
import { coerceManualRunOutcome } from '../src/lib/supabase';
import {
  outcomeToMemoryDisplay,
  recoveredOutcomeUpdate,
} from '../src/lib/ui/memory-librarian';
import { outcomeToLibrarianResult } from '../src/lib/ui/wiki-librarian-run';
import {
  recoveredOutcomeIsFresh,
  MAX_RECOVERED_OUTCOME_AGE_MS,
} from '../src/lib/ui/manual-run-recovery';

describe('coerceManualRunOutcome', () => {
  it('accepts a well-formed envelope and passes result through untyped', () => {
    const raw = {
      runId: 'r1',
      source: 'rem',
      finishedAt: '2026-06-23T00:00:00Z',
      result: { kind: 'ok', conversationsProcessed: 3, toolCalls: 4 },
    };
    expect(coerceManualRunOutcome(raw)).toEqual(raw);
  });

  it('rejects null, non-objects, and envelopes missing required fields', () => {
    expect(coerceManualRunOutcome(null)).toBeNull();
    expect(coerceManualRunOutcome('nope')).toBeNull();
    expect(coerceManualRunOutcome({ source: 'rem', finishedAt: 'x', result: {} })).toBeNull();
    expect(coerceManualRunOutcome({ runId: 'r', finishedAt: 'x', result: {} })).toBeNull();
    expect(coerceManualRunOutcome({ runId: 'r', source: 'rem', finishedAt: 'x' })).toBeNull();
    // empty runId/source are treated as missing
    expect(coerceManualRunOutcome({ runId: '', source: 'rem', finishedAt: 'x', result: {} })).toBeNull();
  });

  it('keeps a falsy-but-present result (result: null is a valid envelope)', () => {
    const raw = { runId: 'r', source: 'rem', finishedAt: 'x', result: null };
    expect(coerceManualRunOutcome(raw)).toEqual(raw);
  });
});

describe('outcomeToMemoryDisplay', () => {
  it('maps a deep-sleep ok result to the deep-sleep pass + result line + text', () => {
    const d = outcomeToMemoryDisplay({
      source: 'deep-sleep',
      result: { kind: 'ok', finalText: '  merged two  ', batchSize: 6, toolCalls: 3 },
    });
    expect(d?.pass).toBe('deep-sleep');
    expect(d?.resultLine).toBe('Reviewed 6 memories with 3 tool calls.');
    expect(d?.resultText).toBe('merged two');
    expect(d?.error).toBeNull();
  });

  it('maps a rem ok result to the rem pass + result line', () => {
    const d = outcomeToMemoryDisplay({
      source: 'rem',
      result: { kind: 'ok', finalText: '', conversationsProcessed: 1, toolCalls: 1 },
    });
    expect(d?.pass).toBe('rem');
    expect(d?.resultLine).toBe('Processed 1 conversation with 1 tool call.');
    expect(d?.resultText).toBeNull(); // empty finalText -> no result text
  });

  it('surfaces an error result as the error field with a fallback message', () => {
    const withMsg = outcomeToMemoryDisplay({ source: 'rem', result: { kind: 'error', error: 'boom' } });
    expect(withMsg?.error).toBe('boom');
    const noMsg = outcomeToMemoryDisplay({ source: 'deep-sleep', result: { kind: 'error' } });
    expect(noMsg?.error).toBe('Deep-sleep run failed.');
  });

  it('returns null for a non-memory source or a busy result', () => {
    expect(outcomeToMemoryDisplay({ source: 'wiki-librarian', result: { kind: 'ok' } })).toBeNull();
    expect(outcomeToMemoryDisplay({ source: 'rem', result: { kind: 'busy' } })).toBeNull();
    expect(outcomeToMemoryDisplay({ source: 'rem', result: {} })).toBeNull();
  });
});

describe('recoveredOutcomeIsFresh', () => {
  const NOW = Date.parse('2026-06-23T12:00:00Z');

  it('treats an outcome within the window as fresh', () => {
    const justNow = new Date(NOW).toISOString();
    expect(recoveredOutcomeIsFresh(justNow, NOW)).toBe(true);
    const edge = new Date(NOW - MAX_RECOVERED_OUTCOME_AGE_MS).toISOString();
    expect(recoveredOutcomeIsFresh(edge, NOW)).toBe(true);
  });

  it('treats an outcome past the window as stale', () => {
    const tooOld = new Date(NOW - MAX_RECOVERED_OUTCOME_AGE_MS - 1).toISOString();
    expect(recoveredOutcomeIsFresh(tooOld, NOW)).toBe(false);
  });

  it('treats an absent or unparseable finishedAt as fresh (legacy envelope)', () => {
    expect(recoveredOutcomeIsFresh(undefined, NOW)).toBe(true);
    expect(recoveredOutcomeIsFresh('not-a-date', NOW)).toBe(true);
  });
});

describe('recoveredOutcomeUpdate', () => {
  const NOW = Date.parse('2026-06-23T12:00:00Z');
  const remOk = {
    runId: 'run-1',
    source: 'rem',
    finishedAt: '2026-06-23T12:00:00Z',
    result: { kind: 'ok', finalText: 'linked three', conversationsProcessed: 2, toolCalls: 5 },
  };

  it('applies a fresh outcome when idle and the runId is new', () => {
    const d = recoveredOutcomeUpdate(remOk, { running: false, shownRunId: null, nowMs: NOW });
    expect(d?.pass).toBe('rem');
    expect(d?.resultLine).toBe('Processed 2 conversations with 5 tool calls.');
    expect(d?.resultText).toBe('linked three');
  });

  it('skips while a live run owns the display (running)', () => {
    expect(recoveredOutcomeUpdate(remOk, { running: true, shownRunId: null, nowMs: NOW })).toBeNull();
  });

  it('skips an outcome already shown (runId matches) - the subscription re-fires on every profiles tick', () => {
    expect(recoveredOutcomeUpdate(remOk, { running: false, shownRunId: 'run-1', nowMs: NOW })).toBeNull();
    // A different runId is NOT deduped.
    expect(recoveredOutcomeUpdate(remOk, { running: false, shownRunId: 'run-0', nowMs: NOW })).not.toBeNull();
  });

  it('skips a non-memory outcome (wrong source) even when idle and new', () => {
    const wiki = { runId: 'r9', source: 'wiki-librarian', finishedAt: '2026-06-23T12:00:00Z', result: { kind: 'ok' } };
    expect(recoveredOutcomeUpdate(wiki, { running: false, shownRunId: null, nowMs: NOW })).toBeNull();
  });

  it('running guard takes precedence over an otherwise-applicable outcome', () => {
    // New runId, valid memory outcome, but a live run is in flight -> skip.
    expect(recoveredOutcomeUpdate(remOk, { running: true, shownRunId: 'other', nowMs: NOW })).toBeNull();
  });

  it('skips a stale outcome that finished outside the recovery window', () => {
    // The reload-after-finish window is 10 min; a run that finished an hour
    // ago must NOT resurface the strip (the cold-load-buries-the-changelog
    // bug). A run that finished 5 min ago still recovers.
    const hourAgo = NOW + 60 * 60 * 1000;
    expect(recoveredOutcomeUpdate(remOk, { running: false, shownRunId: null, nowMs: hourAgo })).toBeNull();
    const fiveMinAgo = NOW + 5 * 60 * 1000;
    expect(recoveredOutcomeUpdate(remOk, { running: false, shownRunId: null, nowMs: fiveMinAgo })).not.toBeNull();
  });

  it('treats an absent or unparseable finishedAt as fresh (legacy envelope)', () => {
    const noStamp = {
      runId: 'run-2',
      source: 'rem',
      result: { kind: 'ok', finalText: '', conversationsProcessed: 1, toolCalls: 1 },
    };
    expect(recoveredOutcomeUpdate(noStamp, { running: false, shownRunId: null, nowMs: NOW })).not.toBeNull();
    const badStamp = { ...noStamp, finishedAt: 'not-a-date' };
    expect(recoveredOutcomeUpdate(badStamp, { running: false, shownRunId: null, nowMs: NOW })).not.toBeNull();
  });
});

describe('outcomeToLibrarianResult', () => {
  it('passes an ok wiki-librarian result through', () => {
    const result = { kind: 'ok', finalText: 'tidied', toolCalls: 4, articleCount: 9 };
    expect(outcomeToLibrarianResult({ source: 'wiki-librarian', result })).toEqual(result);
  });

  it('passes an error result through', () => {
    const result = { kind: 'error', error: 'nope' };
    expect(outcomeToLibrarianResult({ source: 'wiki-librarian', result })).toEqual(result);
  });

  it('returns null for a non-wiki source or a busy/garbage result', () => {
    expect(outcomeToLibrarianResult({ source: 'rem', result: { kind: 'ok' } })).toBeNull();
    expect(outcomeToLibrarianResult({ source: 'wiki-librarian', result: { kind: 'busy' } })).toBeNull();
    expect(outcomeToLibrarianResult({ source: 'wiki-librarian', result: {} })).toBeNull();
  });
});
