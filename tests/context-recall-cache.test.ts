/**
 * Cache + ephemeral coverage for context-recall.
 *
 *   - read/write round-trip via the SupabaseService setter
 *   - inflight registry: two concurrent triggers piggyback onto one
 *     Promise; settle clears the entry so a later trigger starts
 *     fresh
 *   - empty-note short-circuit on the synthetic <think> builder
 */
import { describe, it, expect, vi } from 'vitest';
import {
  readContextRecallCache,
  writeContextRecallCache,
  withContextRecallInflight,
  _clearContextRecallInflightForTests,
} from '../src/lib/context-recall/cache';
import {
  buildContextRecallThinkMessage,
  CONTEXT_RECALL_THINK_MARKER,
} from '../src/lib/context-recall/ephemeral';
import type { ContextRecallPayload } from '../src/lib/context-recall/types';
import type { SupabaseService, Thread } from '../src/lib/supabase';

function payload(overrides: Partial<ContextRecallPayload> = {}): ContextRecallPayload {
  return {
    v: 1,
    note: 'I remember the user prefers concrete examples.',
    computed_at_round: 1,
    computed_at_band: 2,
    computed_at_column: 'confident',
    computed_at_at: 1_700_000_000_000,
    trigger: 'cold',
    ...overrides,
  };
}

function mkThread(payload: unknown): Thread {
  return {
    id: 't-1',
    user_id: 'u-1',
    title: 'x',
    model: null,
    reasoning_effort: null,
    verbosity: null,
    toolboxes_enabled: [],
    archived: false,
    title_manually_set: false,
    intuition_payload: null,
    context_recall_payload: payload,
    topics: [],
    response_holder_id: null,
    response_claim_expires_at: null,
    last_error: null,
    created_at: 'now',
    updated_at: 'now',
  };
}

describe('readContextRecallCache', () => {
  it('returns the coerced payload for a valid row', () => {
    const p = payload();
    expect(readContextRecallCache(mkThread(p))).toEqual(p);
  });

  it('returns null on a drifting / wrong-version row', () => {
    expect(readContextRecallCache(mkThread({ v: 99, note: 'bad' }))).toBeNull();
  });

  it('returns null when the column is null', () => {
    expect(readContextRecallCache(mkThread(null))).toBeNull();
  });

  it('treats an empty note as a valid coerced state', () => {
    // Empty-note negative cache must read back. Otherwise the trigger
    // evaluator can't debounce on the round it was written for.
    const p = payload({ note: '' });
    const out = readContextRecallCache(mkThread(p));
    expect(out).not.toBeNull();
    expect(out!.note).toBe('');
  });
});

describe('writeContextRecallCache', () => {
  it('calls supabase.setThreadContextRecallPayload with the payload', async () => {
    const setter = vi.fn(async () => undefined);
    const svc = {
      setThreadContextRecallPayload: setter,
    } as unknown as SupabaseService;
    const p = payload();
    await writeContextRecallCache(svc, 't-1', p);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith('t-1', p);
  });

  it('swallows persistence errors (the in-memory payload is the source of truth this turn)', async () => {
    const setter = vi.fn(async () => {
      throw new Error('rls denied');
    });
    const svc = {
      setThreadContextRecallPayload: setter,
    } as unknown as SupabaseService;
    // No throw - the mirror behaviour matches writeIntuitionCache.
    // A persist failure is logged, never propagated.
    await expect(
      writeContextRecallCache(svc, 't-1', payload())
    ).resolves.toBeUndefined();
  });
});

describe('withContextRecallInflight', () => {
  it('runs the producer once and returns its result', async () => {
    _clearContextRecallInflightForTests();
    const producer = vi.fn(async () => payload({ note: 'A' }));
    const out = await withContextRecallInflight('t-1', producer);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(out!.note).toBe('A');
  });

  it('piggybacks two concurrent calls onto the same producer Promise', async () => {
    _clearContextRecallInflightForTests();
    let resolveSlow!: (v: ContextRecallPayload | null) => void;
    const slow = new Promise<ContextRecallPayload | null>((r) => {
      resolveSlow = r;
    });
    const producer = vi.fn(() => slow);

    const a = withContextRecallInflight('t-1', producer);
    const b = withContextRecallInflight('t-1', producer);
    expect(producer).toHaveBeenCalledTimes(1); // second call dedup'd

    resolveSlow(payload({ note: 'shared' }));
    const [aOut, bOut] = await Promise.all([a, b]);
    expect(aOut!.note).toBe('shared');
    expect(bOut!.note).toBe('shared');
  });

  it('clears the inflight entry on settle so a later call starts fresh', async () => {
    _clearContextRecallInflightForTests();
    const p1 = vi.fn(async () => payload({ note: 'first' }));
    const p2 = vi.fn(async () => payload({ note: 'second' }));
    await withContextRecallInflight('t-1', p1);
    const out = await withContextRecallInflight('t-1', p2);
    expect(p1).toHaveBeenCalledTimes(1);
    expect(p2).toHaveBeenCalledTimes(1);
    expect(out!.note).toBe('second');
  });

  it('clears the entry even when the producer throws', async () => {
    _clearContextRecallInflightForTests();
    const p1 = vi.fn(async () => {
      throw new Error('boom');
    });
    const p2 = vi.fn(async () => payload({ note: 'second' }));
    await expect(
      withContextRecallInflight('t-1', p1)
    ).rejects.toThrow('boom');
    // Second call should not see the first call's settled (rejected)
    // Promise stuck in the registry.
    const out = await withContextRecallInflight('t-1', p2);
    expect(p2).toHaveBeenCalledTimes(1);
    expect(out!.note).toBe('second');
  });
});

describe('buildContextRecallThinkMessage', () => {
  it('returns a <think>-wrapped assistant message for a non-empty note', () => {
    const msg = buildContextRecallThinkMessage(payload({ note: 'hello' }));
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('assistant');
    expect(typeof msg!.content).toBe('string');
    const c = msg!.content as string;
    expect(c).toContain('<think>');
    expect(c).toContain('</think>');
    expect(c).toContain(CONTEXT_RECALL_THINK_MARKER);
    expect(c).toContain('hello');
  });

  it('returns null for an empty-note negative cache', () => {
    // An empty-note payload is a legitimate cached state but must
    // NOT generate an empty <think> block - that would burn tokens
    // for no information. Caller is expected to skip the injection
    // when this returns null.
    expect(
      buildContextRecallThinkMessage(payload({ note: '' }))
    ).toBeNull();
  });
});
