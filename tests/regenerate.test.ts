import { describe, expect, it } from 'vitest';
import {
  computeRegenerateRangeIds,
  persistedRowIds,
} from '../src/lib/ui/regenerate';
import type { Message } from '../src/lib/supabase';

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    thread_id: 't1',
    role: 'assistant',
    content: '',
    created_at: '2024-01-01T00:00:00Z',
    ...over,
  } as Message;
}

describe('computeRegenerateRangeIds', () => {
  it('returns the clicked assistant turn anchored on its opening user message', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
    ];
    expect(computeRegenerateRangeIds(messages, 'a1')).toEqual(['a1']);
  });

  it('includes intermediate tool rows and every later turn', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
      msg({ id: 't1', role: 'tool' }),
      msg({ id: 'a2' }),
      msg({ id: 'u2', role: 'user' }),
      msg({ id: 'a3' }),
    ];
    // Clicking the first turn's terminal row replaces everything after
    // u1 - including the LATER user turn u2 and its reply.
    expect(computeRegenerateRangeIds(messages, 'a2')).toEqual([
      'a1',
      't1',
      'a2',
      'u2',
      'a3',
    ]);
  });

  it('returns [] when the clicked id is unknown or no user message precedes it', () => {
    const messages = [
      msg({ id: 'a1' }),
      msg({ id: 'u1', role: 'user' }),
    ];
    expect(computeRegenerateRangeIds(messages, 'missing')).toEqual([]);
    expect(computeRegenerateRangeIds(messages, 'a1')).toEqual([]);
  });
});

describe('persistedRowIds', () => {
  it('drops ids whose rows are synthetic, keeps the rest in order', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
      msg({ id: 'synthetic-recovery-asst-0', synthetic: true }),
    ];
    expect(
      persistedRowIds(messages, ['a1', 'synthetic-recovery-asst-0']),
    ).toEqual(['a1']);
  });

  it('passes ids through untouched when nothing is synthetic', () => {
    const messages = [msg({ id: 'u1', role: 'user' }), msg({ id: 'a1' })];
    expect(persistedRowIds(messages, ['a1'])).toEqual(['a1']);
  });
});
