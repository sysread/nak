/**
 * Unit coverage for the browser side of manual-run outcome recovery: the
 * defensive coercion of the persisted jsonb envelope, and the two per-fleet
 * "outcome -> displayed result" transforms. These are the pure functions the
 * reload-recovery path leans on; the runes wiring (the watcher, the bridge
 * effects) composes them in Chat/Memories/Wiki.
 */
import { describe, it, expect } from 'vitest';
import { coerceManualRunOutcome } from '../src/lib/supabase';
import { outcomeToMemoryDisplay } from '../src/lib/ui/memory-librarian';
import { outcomeToLibrarianResult } from '../src/lib/ui/wiki-librarian-run';

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
