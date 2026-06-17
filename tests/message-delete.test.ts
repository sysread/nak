import { describe, expect, it } from 'vitest';
import { computeDeleteFromRangeIds } from '../src/lib/ui/message-delete';
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

describe('computeDeleteFromRangeIds', () => {
  it('returns the clicked user message and its reply', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
    ];
    expect(computeDeleteFromRangeIds(messages, 'u1')).toEqual(['u1', 'a1']);
  });

  it('includes the user message, intermediate tool rows, and every later turn', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
      msg({ id: 'u2', role: 'user' }),
      msg({ id: 'a2' }),
      msg({ id: 'tl', role: 'tool' }),
      msg({ id: 'a3' }),
    ];
    // Deleting from the SECOND turn drops u2 and everything after it,
    // leaving the first turn (u1/a1) intact.
    expect(computeDeleteFromRangeIds(messages, 'u2')).toEqual([
      'u2',
      'a2',
      'tl',
      'a3',
    ]);
  });

  it('returns the whole thread when the first user message is the anchor', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
      msg({ id: 'u2', role: 'user' }),
      msg({ id: 'a2' }),
    ];
    expect(computeDeleteFromRangeIds(messages, 'u1')).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });

  it('returns [] when the id is unknown or the row is not a user message', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
    ];
    expect(computeDeleteFromRangeIds(messages, 'missing')).toEqual([]);
    // Defensive: the button only renders on user rows, but an assistant
    // id must never produce a range.
    expect(computeDeleteFromRangeIds(messages, 'a1')).toEqual([]);
  });
});
