/**
 * Unit coverage for the Recall modal UI primitives. Pure functions
 * - no runes, no DOM, no reactive state - tested via plain vitest.
 *
 * The companion `src/screens/Recall.svelte` and `src/screens/Chat.
 * svelte` are the only callers wiring these into Svelte reactivity;
 * a port to another framework would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import type { ContextRecallPayload } from '../src/lib/context-recall';
import type { Message } from '../src/lib/supabase';
import {
  appendContextRecallHistory,
  buildRecallEntries,
  buildUserMessageByRound,
  formatRecallTimestamp,
  formatRecallTrigger,
  shouldRetainDisplaced,
} from '../src/lib/ui/recall';

function makePayload(
  overrides: Partial<ContextRecallPayload> = {}
): ContextRecallPayload {
  return {
    v: 1,
    note: 'something to say',
    computed_at_round: 1,
    computed_at_band: null,
    computed_at_column: null,
    computed_at_at: 1_700_000_000_000,
    trigger: 'cold',
    ...overrides,
  };
}

function makeMessage(
  id: string,
  role: Message['role'],
  content: string,
  createdAt = '2026-05-22T12:00:00.000Z'
): Message {
  return {
    id,
    thread_id: 't',
    role,
    content,
    created_at: createdAt,
  };
}

describe('buildRecallEntries', () => {
  it('returns the current payload first, then history newest-first', () => {
    const current = makePayload({ computed_at_round: 5, note: 'now' });
    const oldest = makePayload({ computed_at_round: 1, note: 'oldest' });
    const middle = makePayload({ computed_at_round: 3, note: 'middle' });
    // history is landing order, oldest first
    const out = buildRecallEntries(current, [oldest, middle]);
    expect(out.map((p) => p.note)).toEqual(['now', 'middle', 'oldest']);
  });

  it('omits the current payload when null', () => {
    const a = makePayload({ note: 'a' });
    expect(buildRecallEntries(null, [a]).map((p) => p.note)).toEqual(['a']);
  });

  it('drops empty-note entries at both layers', () => {
    const current = makePayload({ note: '   ' });
    const real = makePayload({ note: 'real' });
    const empty = makePayload({ note: '' });
    const out = buildRecallEntries(current, [empty, real, empty]);
    expect(out.map((p) => p.note)).toEqual(['real']);
  });

  it('returns an empty list when there is nothing to show', () => {
    expect(buildRecallEntries(null, [])).toEqual([]);
  });

  it('does not mutate the input history', () => {
    const a = makePayload({ note: 'a' });
    const b = makePayload({ note: 'b' });
    const input = [a, b];
    buildRecallEntries(null, input);
    expect(input).toEqual([a, b]);
  });
});

describe('formatRecallTrigger', () => {
  it('maps each trigger value to a distinct label', () => {
    const labels = new Set([
      formatRecallTrigger('cold'),
      formatRecallTrigger('title'),
      formatRecallTrigger('mood'),
      formatRecallTrigger('stale'),
    ]);
    expect(labels.size).toBe(4);
  });

  it('mentions the title-change source for the title trigger', () => {
    expect(formatRecallTrigger('title')).toMatch(/title/i);
  });
});

describe('formatRecallTimestamp', () => {
  it('returns a non-empty string for a finite number', () => {
    const out = formatRecallTimestamp(1_700_000_000_000);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('falls back to the raw stringification for a non-finite input', () => {
    // toLocaleString on an Invalid Date returns 'Invalid Date', not a
    // throw; the catch path is defensive. The contract is "always
    // returns a string", which both paths satisfy.
    expect(typeof formatRecallTimestamp(Number.NaN)).toBe('string');
  });
});

describe('shouldRetainDisplaced', () => {
  it('returns true when the timestamps differ', () => {
    const displaced = makePayload({ computed_at_at: 100 });
    const incoming = makePayload({ computed_at_at: 200 });
    expect(shouldRetainDisplaced(displaced, incoming)).toBe(true);
  });

  it('returns false when the timestamps match - the realtime-echo dedup case', () => {
    const displaced = makePayload({ computed_at_at: 100 });
    const incoming = makePayload({ computed_at_at: 100 });
    expect(shouldRetainDisplaced(displaced, incoming)).toBe(false);
  });
});

describe('appendContextRecallHistory', () => {
  it('appends to the existing per-thread list', () => {
    const a = makePayload({ note: 'a' });
    const b = makePayload({ note: 'b' });
    const initial = new Map<string, ContextRecallPayload[]>([['t1', [a]]]);
    const out = appendContextRecallHistory(initial, 't1', b);
    expect(out.get('t1')!.map((p) => p.note)).toEqual(['a', 'b']);
  });

  it('creates a new per-thread list when the thread is unseen', () => {
    const a = makePayload({ note: 'a' });
    const out = appendContextRecallHistory(new Map(), 't1', a);
    expect(out.get('t1')!.map((p) => p.note)).toEqual(['a']);
  });

  it('returns a fresh Map - the input is not mutated', () => {
    const a = makePayload({ note: 'a' });
    const initial = new Map<string, ContextRecallPayload[]>([['t1', []]]);
    const out = appendContextRecallHistory(initial, 't1', a);
    expect(out).not.toBe(initial);
    expect(initial.get('t1')).toEqual([]);
  });

  it('does not leak the new per-thread array to other threads', () => {
    const a = makePayload({ note: 'a' });
    const b = makePayload({ note: 'b' });
    const initial = new Map<string, ContextRecallPayload[]>([['t1', [a]]]);
    const out = appendContextRecallHistory(initial, 't2', b);
    expect(out.get('t1')!.map((p) => p.note)).toEqual(['a']);
    expect(out.get('t2')!.map((p) => p.note)).toEqual(['b']);
  });
});

describe('buildUserMessageByRound', () => {
  it('keys user messages by 1-based round number', () => {
    const u1 = makeMessage('u1', 'user', 'first');
    const a1 = makeMessage('a1', 'assistant', 'reply');
    const u2 = makeMessage('u2', 'user', 'second');
    const out = buildUserMessageByRound([u1, a1, u2]);
    expect(out.get(1)?.id).toBe('u1');
    expect(out.get(2)?.id).toBe('u2');
    expect(out.size).toBe(2);
  });

  it('skips tool and assistant rows without advancing the counter', () => {
    const u1 = makeMessage('u1', 'user', 'first');
    const a1 = makeMessage('a1', 'assistant', '');
    const t1 = makeMessage('t1', 'tool', 'result');
    const u2 = makeMessage('u2', 'user', 'second');
    const out = buildUserMessageByRound([u1, a1, t1, u2]);
    expect(out.get(1)?.id).toBe('u1');
    expect(out.get(2)?.id).toBe('u2');
  });

  it('returns an empty map for a cold thread', () => {
    expect(buildUserMessageByRound([]).size).toBe(0);
  });
});
